import { computed, reactive, ref, toRefs } from 'vue'
import type { DecisionVersion, ReviewDecisionDraft, ReviewScope } from '#sme-roster/lib/roster/evidence-review-ui'
import { DIFFERENCE_MEASURES, DIFFERENCE_REASONS } from '#sme-roster/lib/labels'

export interface InitialDecisionHead extends ReviewScope { versionId: number | null; current: DecisionVersion | null }
export interface InitialDecisionReceipt { versionId: number; currentId?: number | null; previousId?: number | null; action?: string | null; recordedAt?: string }
interface InitialDecisionApi {
  context: () => Promise<{ writeEnabled?: boolean }>
  current: () => Promise<InitialDecisionHead>
  version?: (id: number) => Promise<DecisionVersion>
  post: (body: Record<string, unknown>) => Promise<InitialDecisionReceipt>
}
export function emptyInitialDecisionDraft(): ReviewDecisionDraft {
  return { status: '', reasonCode: '', reasonNote: '', measureCode: '', measureNote: '', evidenceQueryId: '', evidenceRelationId: '' }
}
/** One ordinary browser command, retained only for the lifetime of its exact-scope host. No credentials. */
export function createInitialDecisionState(scope: ReviewScope) {
  return reactive({
    scope: { ...scope }, basis: '', draft: emptyInitialDecisionDraft(), head: null as InitialDecisionHead | null,
    writeState: 'loading' as 'loading' | 'ready' | 'readonly' | 'unavailable',
    phase: 'loading' as 'loading' | 'ready' | 'saving' | 'conflict' | 'unknown' | 'readback' | 'saved' | 'superseded' | 'error',
    message: '', correctionAccepted: false, busy: false, notified: false,
    request: null as Record<string, unknown> | null, receipt: null as InitialDecisionReceipt | null,
    submittedVersion: null as DecisionVersion | null,
  })
}
export type InitialDecisionState = ReturnType<typeof createInitialDecisionState>
export function initialDecisionNeedsGuard(state: InitialDecisionState): boolean {
  if (state.request) return state.phase !== 'saved' && state.phase !== 'superseded'
  return !!state.basis || Object.values(state.draft).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value))
}
const sameScope = (a: ReviewScope, b: ReviewScope) => a.enterpriseId === b.enterpriseId && a.titleCode === b.titleCode && a.direction === b.direction

/** References a host-owned session, so late completion and structural remount share the same request/receipt. */
export function useInitialDifferenceDecision(scope: ReviewScope, api: InitialDecisionApi, state = createInitialDecisionState(scope), ownsSession: () => boolean = () => true) {
  if (!sameScope(scope, state.scope)) throw new Error('Initial decision host scope mismatch')
  const { basis, draft, head, writeState, phase, message, correctionAccepted, receipt, submittedVersion } = toRefs(state)
  // #274 invariants: unsent intent is revocable; the complete request belongs to the
  // live exact-key host before POST; dispatched completion belongs only to that session.
  const attached = ref(true)
  let generation = 0
  let pending: { generation: number; retained: boolean } | null = null
  function start(retained = false) {
    if (state.busy || !ownsSession() || !attached.value && !retained) return null
    const operation = { generation: ++generation, retained }
    pending = operation; state.busy = true
    return operation
  }
  const current = (operation: NonNullable<typeof pending>) => pending === operation && operation.generation === generation
    && ownsSession() && (attached.value || operation.retained)
  function finish(operation: NonNullable<typeof pending>) {
    if (current(operation)) { state.busy = false; pending = null }
  }
  function dispose() {
    attached.value = false
    // Detaching revokes preflight, including retries, but never erases a dispatched identity.
    if (pending && !pending.retained) {
      generation++; pending = null
      if (ownsSession()) state.busy = false
    }
  }
  const dirty = computed(() => initialDecisionNeedsGuard(state))
  const locked = computed(() => !!state.receipt || ['saving', 'unknown', 'loading'].includes(state.phase))
  const validId = (id: string) => !id || /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))
  const decisionReady = computed(() => {
    const d = draft.value
    return Object.hasOwn(DIFFERENCE_MEASURES, d.measureCode)
      && (d.status === 'confirmed_no_diff' ? d.measureCode === 'none'
        : d.status === 'confirmed_reason' && Object.hasOwn(DIFFERENCE_REASONS, d.reasonCode) && (d.reasonCode !== 'pending_review' || d.measureCode === 'follow_review'))
      && validId(d.evidenceQueryId) && validId(d.evidenceRelationId)
  })
  const canSave = computed(() => attached.value && ownsSession() && !state.busy && phase.value === 'ready' && writeState.value === 'ready' && !!head.value
    && (!head.value.current || correctionAccepted.value) && !!basis.value.trim() && basis.value.trim().length <= 4000 && decisionReady.value)
  async function readWriteCapability(operation: NonNullable<typeof pending>) {
    writeState.value = 'loading'
    try {
      const context = await api.context()
      if (current(operation)) writeState.value = context?.writeEnabled === true ? 'ready' : context?.writeEnabled === false ? 'readonly' : 'unavailable'
    } catch { if (current(operation)) writeState.value = 'unavailable' }
  }
  async function recheckCapability() {
    const operation = start()
    if (!operation) return
    try { await readWriteCapability(operation) } finally { finish(operation) }
  }
  let beginning: Promise<boolean> | null = null
  function begin(): Promise<boolean> {
    if (beginning) return beginning
    if (!head.value || !['ready', 'saved', 'superseded'].includes(phase.value)) return Promise.resolve(false)
    const operation = start()
    if (!operation) return Promise.resolve(false)
    beginning = (async () => {
      try {
        await readWriteCapability(operation)
        if (!current(operation) || writeState.value !== 'ready') return false
        if (phase.value === 'saved' || phase.value === 'superseded') {
          // Only a fresh capability and explicit human action may end the verified submission.
          state.request = null; state.receipt = null; state.submittedVersion = null; state.notified = false
          basis.value = ''; draft.value = emptyInitialDecisionDraft(); phase.value = 'ready'; message.value = ''
        }
        correctionAccepted.value = true
        return true
      } finally { finish(operation); beginning = null }
    })()
    return beginning
  }
  function validateVersion(value: DecisionVersion, id: number) {
    if (!value || value.id !== id || !sameScope(value, scope)) throw new Error('Invalid submitted decision version')
    return value
  }
  async function readHead(operation: NonNullable<typeof pending>) {
    const value = await api.current()
    if (!current(operation)) return
    if (!value || !Object.hasOwn(value, 'current') || value.current === undefined || !sameScope(value, scope)
      || !(value.versionId === null || Number.isSafeInteger(value.versionId) && value.versionId > 0)) throw new Error('Invalid scope head')
    if (value.current) validateVersion(value.current, value.versionId!)
    head.value = value
  }
  async function load() {
    const operation = start(!!state.receipt)
    if (!operation) return
    const unknownRequest = phase.value === 'unknown'
    if (!unknownRequest) {
      phase.value = state.receipt ? 'readback' : 'loading'; message.value = ''; correctionAccepted.value = false
    }
    try {
      // Capability is independent of head identity. Unknown recovery checks only capability.
      await readWriteCapability(operation)
      if (!current(operation) || unknownRequest) return
      await readHead(operation)
      if (!current(operation)) return
      if (!state.receipt) { phase.value = 'ready'; return }
      const id = state.receipt.versionId
      // current is proof of this submission only when its stable ID and nested scope both match.
      const own = api.version ? await api.version(id) : head.value?.current?.id === id ? head.value.current : null
      if (!current(operation)) return
      submittedVersion.value = validateVersion(own!, id)
      if (head.value?.current?.id === id && own?.isCurrent !== false) {
        phase.value = 'saved'
        message.value = `已提交并读回当前决定 #${id}；本次版本已核实。`
      } else if (head.value?.versionId != null && head.value.versionId !== id) {
        phase.value = 'superseded'
        message.value = head.value.current
          ? `本次提交版本 #${id} 已读回；当前已由后续版本 #${head.value.versionId} 替代。历史保留，追加更正须重新核对当前决定。`
          : `本次提交版本 #${id} 已读回；后续撤回版本 #${head.value.versionId} 已生效，当前无有效决定。历史保留，可人工重新登记。`
      } else throw new Error('Current head and submitted version disagree')
    } catch {
      if (!current(operation)) return
      phase.value = state.receipt ? 'readback' : 'error'
      message.value = state.receipt ? `判断已提交（回执 #${state.receipt.versionId}），本次版本或当前决定待核读回。请仅重试读取，不要重复登记。` : '当前决定读取失败；填写内容保留，读取成功前只读。'
    } finally { finish(operation) }
  }
  async function save() {
    if (beginning) await beginning
    if (!attached.value || state.receipt || (!canSave.value && phase.value !== 'unknown')) return
    const operation = start()
    if (!operation) return
    try {
      await readWriteCapability(operation)
      if (!current(operation) || writeState.value !== 'ready') return
      if (!state.request) {
        const d = draft.value
        state.request = { ...scope, action: 'replace', expectedCurrentId: head.value!.versionId, basis: basis.value.trim(),
          effectiveAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(),
          decision: { status: d.status, reasonCode: d.status === 'confirmed_no_diff' ? null : d.reasonCode,
            reasonNote: d.reasonNote.trim() || null, measureCode: d.measureCode, measureNote: d.measureNote.trim() || null,
            verificationStatus: 'confirmed', evidenceQueryId: d.evidenceQueryId ? Number(d.evidenceQueryId) : null,
            evidenceRelationId: d.evidenceRelationId ? Number(d.evidenceRelationId) : null,
            ...(d.factReferences?.length ? { factReferences: d.factReferences } : {}) } }
      }
      // No await between this host-owned identity and dispatch. The Form watcher is not the owner.
      phase.value = 'saving'; message.value = ''; operation.retained = true
      const response = await api.post(state.request)
      if (!current(operation)) return
      if (!Number.isSafeInteger(response?.versionId) || response.versionId <= 0) throw new Error('Invalid receipt')
      state.receipt = { versionId: response.versionId, currentId: response.currentId, previousId: response.previousId, action: response.action, recordedAt: response.recordedAt }; phase.value = 'readback'
    } catch (error) {
      if (!current(operation)) return
      const e = error as { status?: number; statusCode?: number; data?: { error?: { code?: string } } }
      const code = e?.data?.error?.code
      if (['stale_version', 'stale_evidence', 'idempotency_conflict'].includes(code ?? '') || e?.status === 409 || e?.statusCode === 409) {
        phase.value = 'conflict'; state.request = null
        message.value = '当前决定已变化或提交冲突。草稿保留；请重新读取当前决定，核对后明确追加更正。'
      } else if (['origin_required', 'origin_mismatch', 'cross_site_request', 'unsupported_media_type', 'invalid_request', 'evidence_mismatch', 'evidence_not_found', 'invalid_prior_time', 'fact_reference_mismatch'].includes(code ?? '')) {
        phase.value = 'ready'; state.request = null
        message.value = code === 'fact_reference_mismatch' ? '关联事实已变化，填写内容保留。请刷新可关联事实，重新选择后提交。' : '提交未被接受，填写内容保留。请核对业务字段或重新读取页面提交能力。'
      } else {
        phase.value = 'unknown'
        message.value = '提交结果尚不能确认。填写内容已锁定；请重试同一次提交，系统会复用原提交标识。'
      }
    } finally { finish(operation) }
    if (ownsSession() && state.receipt) await load()
  }
  const canRetry = computed(() => attached.value && ownsSession() && phase.value === 'unknown' && writeState.value === 'ready' && !state.busy)
  return { basis, draft, head, writeState, phase, message, correctionAccepted, receipt, submittedVersion, dirty, locked, canSave, canRetry, begin, load, save, recheckCapability, dispose, state }
}
