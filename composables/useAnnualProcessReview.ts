import { computed, onBeforeUnmount, onMounted, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { EventAnnualProcessPage } from '~~/lib/roster/annual-process'
import type { AnnualTaskDto, AnnualTaskReceipt } from '~~/lib/roster/annual-correspondence'
import type { CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import { annualReasonText, presentAnnualProcess, type AnnualReviewPhase } from '~~/lib/roster/annual-process-presentation'
import { isTerminalJobState } from '~~/lib/job'
import { useTaskPolling } from './useTaskPolling'
import { refreshCorrespondenceViews, useCorrespondenceReadback } from './useCorrespondenceReadback'

/** Browser-local recovery identity, not a credential or a second backend DTO. */
interface Recovery { clientRequestId: string; generation: string; jobId?: string }
const storageKey = (eventId: number) => `roster-annual-review:v1:${eventId}`
function restore(eventId: number): Recovery | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(eventId)) ?? 'null')
    return value && typeof value.clientRequestId === 'string' && typeof value.generation === 'string' && (!value.jobId || typeof value.jobId === 'string') ? value : null
  } catch { return null }
}

/** One mounted review coordinates only its selected event. The annual read is
 * joined to the existing readback barrier; task history never supplies final. */
export function useAnnualProcessReview(activeEventId: MaybeRefOrGetter<number | null>) {
  const raw = shallowRef<EventAnnualProcessPage | null>(null)
  const phase = shallowRef<AnnualReviewPhase>('checking')
  const enabled = shallowRef(false)
  const reading = shallowRef(false)
  const readFailed = shallowRef(false)
  const acting = shallowRef(false)
  const actionError = shallowRef('')
  const target = shallowRef({ page: 1, pageSize: 50 })
  const recovery = shallowRef<Recovery | null>(null)
  const task = shallowRef<AnnualTaskDto | null>(null)
  const auditReadback = shallowRef<{ id: number; revision: number; status: string }[]>([])
  const pollKey = shallowRef('')
  let mounted = false
  let epoch = 0
  let readSequence = 0
  let readController: AbortController | undefined
  let syncing: Promise<void> | null = null
  const eventId = () => toValue(activeEventId)
  const current = (token: number, id: number) => mounted && epoch === token && eventId() === id
  function save(id: number, value: Recovery) {
    recovery.value = value
    try { sessionStorage.setItem(storageKey(id), JSON.stringify(value)) } catch { /* Retain identity in the mounted controller if storage is unavailable. */ }
  }

  async function readAnnual(): Promise<boolean> {
    const id = eventId(), token = epoch
    if (!mounted || id == null) return true
    const sequence = ++readSequence, request = { ...target.value }
    readController?.abort(); const controller = new AbortController(); readController = controller
    reading.value = true; readFailed.value = false
    try {
      const page = await $fetch<EventAnnualProcessPage>(`/api/roster/events/${id}/annual-process`, { query: request, signal: controller.signal })
      if (!current(token, id) || sequence !== readSequence) return false
      if (page.process.event.id !== id || !page.sourceGeneration || page.page !== request.page || page.pageSize !== request.pageSize || !Array.isArray(page.process.steps)) throw new Error('annual_read_mismatch')
      const sourceChanged = raw.value?.sourceGeneration !== page.sourceGeneration
      raw.value = page
      if (sourceChanged && enabled.value && recovery.value?.jobId && recovery.value.generation !== page.sourceGeneration) {
        phase.value = 'blocked'; auditReadback.value = []; watchJob(recovery.value.jobId)
      }
      return true
    } catch {
      if (current(token, id) && sequence === readSequence) readFailed.value = true
      return false
    } finally { if (current(token, id) && sequence === readSequence) reading.value = false }
  }
  async function readActiveAnnual(): Promise<boolean> {
    for (;;) {
      const id = eventId()
      if (id == null || !mounted) return true
      let changed!: () => void
      const selection = new Promise<void>(resolve => { changed = resolve })
      const stop = watch(eventId, changed, { flush: 'sync' })
      let result: boolean | void
      try { result = await Promise.race([readAnnual(), selection]) } finally { stop() }
      if (eventId() !== id) continue
      return result === true
    }
  }
  useCorrespondenceReadback(readActiveAnnual)

  const polling = useTaskPolling(pollKey, signal => $fetch<AnnualTaskDto>(`/api/roster/annual-correspondence-tasks/${pollKey.value}`, { signal }))
  function watchJob(id: string) {
    if (pollKey.value === id) void polling.refresh()
    else pollKey.value = id
  }
  async function acceptReceipt(receipt: AnnualTaskReceipt, token: number, id: number) {
    if (!current(token, id)) return
    const source = receipt.sourceGenerations.find(source => source.eventId === id)
    if (receipt.kind !== 'event-annual-correspondence' || !source?.generation || !recovery.value) throw new Error('annual_receipt_mismatch')
    save(id, { ...recovery.value, generation: source.generation, jobId: receipt.jobId })
    task.value = null; phase.value = 'running'; watchJob(receipt.jobId)
  }
  async function submit() {
    const id = eventId(), token = epoch
    if (id == null || !enabled.value || !raw.value || acting.value) return
    const identity = recovery.value ?? { clientRequestId: crypto.randomUUID(), generation: raw.value.sourceGeneration }
    // Save before the first write, including an unknown result. Never rotate an
    // ambiguous identity just because a later read has a different generation.
    save(id, identity)
    acting.value = true; phase.value = 'submitting'; actionError.value = ''
    try {
      const receipt = await $fetch<AnnualTaskReceipt>(`/api/roster/events/${id}/annual-correspondence-tasks`, { method: 'POST', body: { clientRequestId: identity.clientRequestId } })
      await acceptReceipt(receipt, token, id)
    } catch (cause) {
      if (current(token, id)) {
        const failure = cause as { statusCode?: number; status?: number; data?: { error?: { code?: string } } }
        const refused = [401, 403].includes(failure.statusCode ?? failure.status ?? 0)
          && ['readonly_database', 'browser_review_disabled', 'unauthorized'].includes(failure.data?.error?.code ?? '')
        if (refused) {
          // These protected-route refusals happen before enqueueing. They are
          // explicit no-write answers, unlike a network/unknown result.
          enabled.value = false; phase.value = 'read-only'; recovery.value = null
          try { sessionStorage.removeItem(storageKey(id)) } catch { /* No credential is stored. */ }
        } else phase.value = 'unknown'
      }
    }
    finally { if (current(token, id)) acting.value = false }
  }
  async function renewChangedSource(token: number, id: number) {
    phase.value = 'blocked'
    const old = recovery.value?.generation
    if (!await readAnnual() || !current(token, id) || !enabled.value || !raw.value || raw.value.sourceGeneration === old) return
    // Only called after GET explicitly reported source_generation_changed.
    save(id, { clientRequestId: crypto.randomUUID(), generation: raw.value.sourceGeneration })
    task.value = null; auditReadback.value = []
    await submit()
  }
  async function auditCurrentTask(token: number, id: number) {
    const refs = task.value?.result?.events.find(event => event.eventId === id)?.outcomes.flatMap(outcome => outcome.decisionRefs) ?? []
    const targets = new Map(refs.map(ref => [ref.id, ref.revision]))
    for (const ref of raw.value?.process.finalQualification?.decisionRefs ?? []) targets.set(ref.id, Math.max(targets.get(ref.id) ?? 0, ref.revision))
    const points = await Promise.all([...targets].map(async ([pointId, revision]) => {
      const point = await $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${pointId}`)
      if (point.id !== pointId || point.eventId !== id || point.revision < revision) throw new Error('point_readback_mismatch')
      let found = false
      for (let page = 1; !found; page++) {
        const audit = await $fetch<{ rows: { correspondenceId: number; resultingRevision: number }[]; page: number; pageSize: number; total: number }>(`/api/roster/correspondences/${pointId}/audit`, { query: { page, pageSize: 200 } })
        if (audit.page !== page || audit.pageSize !== 200 || !Array.isArray(audit.rows)
          || !Number.isSafeInteger(audit.total) || audit.total < 0
          || audit.rows.length !== Math.min(200, Math.max(0, audit.total - (page - 1) * 200))) throw new Error('audit_readback_mismatch')
        found = audit.rows.some(row => row.correspondenceId === pointId && row.resultingRevision === point.revision)
        if (!found && page * audit.pageSize >= audit.total) throw new Error('audit_readback_missing')
      }
      return { id: point.id, revision: point.revision, status: point.status }
    }))
    if (current(token, id)) auditReadback.value = points
  }
  async function synchronize() {
    if (syncing) return syncing
    const id = eventId(), token = epoch
    if (id == null || !recovery.value?.jobId) return
    const jobId = recovery.value.jobId
    const run = async () => {
      phase.value = 'syncing'; actionError.value = ''
      try {
        await refreshCorrespondenceViews()
        if (!current(token, id) || recovery.value?.jobId !== jobId) return
        if (raw.value?.sourceGeneration !== recovery.value.generation) {
          phase.value = 'blocked'; watchJob(jobId); return
        }
        await auditCurrentTask(token, id)
        if (current(token, id) && recovery.value?.jobId === jobId) {
          if (raw.value?.sourceGeneration !== recovery.value.generation) { phase.value = 'blocked'; watchJob(jobId) }
          else phase.value = 'synced'
        }
      } catch { if (current(token, id) && recovery.value?.jobId === jobId) phase.value = 'sync-failed' }
    }
    const promise = run(); syncing = promise
    try { await promise } finally { if (syncing === promise) syncing = null }
  }
  watch(polling.data, async value => {
    const id = eventId(), token = epoch
    if (!value || id == null || polling.sourceKey.value !== recovery.value?.jobId || value.jobId !== recovery.value?.jobId) return
    const outcome = value.result?.events.find(event => event.eventId === id)
    if (value.kind !== 'event-annual-correspondence' || outcome && outcome.generation !== recovery.value.generation) return
    task.value = value
    if (outcome?.finalQualification.reasons.includes('source_generation_changed')) {
      pollKey.value = ''; await renewChangedSource(token, id); return
    }
    if (isTerminalJobState(value.status)) {
      pollKey.value = ''
      if (value.status === 'done' && outcome?.status === 'done') await synchronize()
      else phase.value = value.status === 'cancelled' ? 'cancelled' : 'failed'
    } else phase.value = 'running'
  })

  async function refresh(patch: Partial<typeof target.value> = {}) {
    target.value = { ...target.value, ...patch }
    if (!await readAnnual() || eventId() == null) return
    if (!enabled.value) { phase.value = 'read-only'; return }
    if (phase.value === 'unknown') return
    if (recovery.value?.jobId) {
      if (raw.value?.sourceGeneration !== recovery.value.generation) { phase.value = 'blocked'; watchJob(recovery.value.jobId) }
      else if (!task.value) { phase.value = 'running'; watchJob(recovery.value.jobId) }
      else if (phase.value === 'sync-failed' || phase.value === 'synced') await synchronize()
      return
    }
    await submit()
  }
  async function taskAction(action: 'retry' | 'cancel') {
    const id = eventId(), token = epoch, jobId = recovery.value?.jobId
    if (id == null || !jobId || !enabled.value || acting.value || !task.value?.capabilities[action]) return
    acting.value = true; actionError.value = ''
    try {
      if (action === 'retry') await acceptReceipt(await $fetch<AnnualTaskReceipt>(`/api/roster/annual-correspondence-tasks/${jobId}/retry`, { method: 'POST', body: {} }), token, id)
      else await $fetch(`/api/roster/annual-correspondence-tasks/${jobId}/cancel`, { method: 'POST', body: {} })
    } catch { if (current(token, id)) actionError.value = '任务操作结果尚未确认，正在重新读取原任务；不会新建提交。' }
    finally { if (current(token, id)) { acting.value = false; watchJob(jobId) } }
  }
  async function start() {
    epoch++; readSequence++; readController?.abort(); pollKey.value = ''; syncing = null
    raw.value = null; task.value = null; reading.value = false; readFailed.value = false; acting.value = false; enabled.value = false
    recovery.value = null; auditReadback.value = []; actionError.value = ''; phase.value = 'checking'; target.value = { page: 1, pageSize: 50 }
    const id = eventId(), token = epoch
    if (!mounted || id == null) return
    recovery.value = restore(id)
    const capability = (async () => {
      try { return (await $fetch<{ writeEnabled: boolean }>('/api/roster/evidence-review/browser-context')).writeEnabled === true }
      catch { return false }
    })()
    const [read, writable] = await Promise.all([readAnnual(), capability])
    if (!current(token, id)) return
    enabled.value = writable
    if (!writable) { phase.value = 'read-only'; return }
    if (!read) return
    if (recovery.value?.jobId) { phase.value = 'running'; watchJob(recovery.value.jobId) }
    else if (recovery.value) phase.value = 'unknown'
    else await submit()
  }
  watch(eventId, () => { void start() }, { flush: 'sync' })
  onMounted(() => { mounted = true; void start() })
  onBeforeUnmount(() => { mounted = false; epoch++; readSequence++; readController?.abort(); pollKey.value = '' })
  const outcome = computed(() => task.value?.result?.events.find(event => event.eventId === eventId()))
  const capabilitiesCurrent = computed(() => enabled.value && raw.value?.sourceGeneration === recovery.value?.generation && !acting.value)
  return {
    view: computed(() => raw.value ? presentAnnualProcess(raw.value) : null), phase, readFailed, target,
    pending: computed(() => reading.value || acting.value || phase.value === 'syncing'),
    canCancel: computed(() => capabilitiesCurrent.value && !!task.value?.capabilities.cancel),
    canRetry: computed(() => capabilitiesCurrent.value && !!task.value?.capabilities.retry),
    taskReadFailed: polling.failed, actionError, auditReadback,
    progress: computed(() => task.value ? `已处理 ${task.value.progress.done} / ${task.value.progress.total} 个事件` : ''),
    businessReasons: computed(() => [...new Set([...(outcome.value?.finalQualification.reasons ?? []), ...(task.value?.errorCode ? [task.value.errorCode] : [])])].map(annualReasonText)),
    refresh, retrySubmit: submit, retryReadback: synchronize, retryTask: () => taskAction('retry'), cancel: () => taskAction('cancel'), retryTaskRead: () => recovery.value?.jobId && watchJob(recovery.value.jobId),
  }
}
