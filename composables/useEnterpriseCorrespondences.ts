import { useCorrespondenceReadback } from './useCorrespondenceReadback'
import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { CorrespondenceDetail, CorrespondenceSummary } from '~~/lib/roster/correspondence-view'

interface CorrespondencePage {
  rows: CorrespondenceSummary[]
  total: number
  page: number
  pageSize: number
}

/**
 * 一家企业的全部对应关系（含已确认、候选、已拒绝/解除、当前参考与后续流程）。
 *
 * 列表只读取边的摘要；展开具体事件时才按边 ID 读取完整出处。
 * 这不是判定：接口仍逐条返回自己的状态，页面只决定「哪些算本事件出处」。
 */
export function useEnterpriseCorrespondences(enterpriseId: MaybeRefOrGetter<number | null>, activeEventId?: MaybeRefOrGetter<number | null>) {
  const rows = ref<CorrespondenceSummary[]>([])
  const loading = ref(false)
  const error = ref(false)
  const ready = ref(false)
  type EventDetails = { key: string; loading: boolean; error: boolean; rows: CorrespondenceDetail[] | null }
  const eventDetails = ref<Record<number, EventDetails>>({})
  const eventRequestIds = new Map<number, number>()
  const eventReads = new Map<number, { key: string; promise: Promise<void> }>()
  let nextEventRequestId = 0
  let requestId = 0
  let ownerId: number | null = null

  const eventRows = (eventId: number) => rows.value.filter(row => row.eventId === eventId && row.type !== 'later_process')
  const eventKey = (eventId: number) => JSON.stringify([ownerId, eventId, eventRows(eventId).map(row => [
    row.id, row.revision, row.type, row.role, row.status, row.requiresRevalidation,
    row.eventId, row.predecessorEventId, row.relationId, row.exportRowId, row.enterpriseId, row.titleCode,
  ])])
  function detailsForEvent(eventId: number): CorrespondenceDetail[] | null {
    if (!ready.value) return null
    const selected = eventRows(eventId)
    if (!selected.length) return []
    const state = eventDetails.value[eventId]
    return state?.key === eventKey(eventId) ? state.rows : null
  }
  function detailLoadingForEvent(eventId: number) {
    const state = eventDetails.value[eventId]
    return !!state && state.key === eventKey(eventId) && state.loading
  }
  function detailErrorForEvent(eventId: number) {
    const state = eventDetails.value[eventId]
    return !!state && state.key === eventKey(eventId) && state.error
  }
  function loadEvent(eventId: number, force = false): Promise<void> {
    if (!ready.value || ownerId == null) return Promise.resolve()
    const key = eventKey(eventId)
    const current = eventReads.get(eventId)
    if (!force && current?.key === key) return current.promise
    if (!force && eventDetails.value[eventId]?.key === key && eventDetails.value[eventId]?.rows) return Promise.resolve()
    const promise = readEvent(eventId, force)
    eventReads.set(eventId, { key, promise })
    return promise.finally(() => {
      if (eventReads.get(eventId)?.promise === promise) eventReads.delete(eventId)
    })
  }

  async function readEvent(eventId: number, force: boolean): Promise<void> {
    if (!ready.value || ownerId == null) return
    if (force) {
      // A point may have advanced since the list succeeded. One explicit retry
      // reconciles the complete, paged summary first; never retry automatically.
      const retryOwner = ownerId
      const retryKey = eventKey(eventId)
      const retryId = ++nextEventRequestId
      const prior = eventDetails.value[eventId]
      eventRequestIds.set(eventId, retryId)
      eventDetails.value = { ...eventDetails.value, [eventId]: { key: retryKey, loading: true, error: false, rows: prior?.key === retryKey ? prior.rows : null } }
      const refreshed = await load()
      if (ownerId !== retryOwner) return
      if (eventRequestIds.get(eventId) !== retryId) return eventReads.get(eventId)?.promise
      if (!refreshed) {
        eventDetails.value = { ...eventDetails.value, [eventId]: { key: retryKey, loading: false, error: true, rows: prior?.key === retryKey ? prior.rows : null } }
        return
      }
    }
    const selected = eventRows(eventId)
    if (!selected.length) return
    const key = eventKey(eventId)
    const prior = eventDetails.value[eventId]
    const eventRequestId = ++nextEventRequestId
    eventRequestIds.set(eventId, eventRequestId)
    eventDetails.value = { ...eventDetails.value, [eventId]: { key, loading: true, error: false, rows: prior?.key === key ? prior.rows : null } }
    try {
      const resolved = await Promise.all(selected.map(row => $fetch<CorrespondenceDetail>(`/api/roster/correspondences/${row.id}`)))
      if (eventKey(eventId) !== key || eventDetails.value[eventId]?.key !== key || eventRequestIds.get(eventId) !== eventRequestId) return
      if (resolved.some((point, index) => {
        const summary = selected[index]!
        return point.id !== summary.id || point.revision !== summary.revision || point.status !== summary.status
          || point.type !== summary.type || point.role !== summary.role || point.requiresRevalidation !== summary.requiresRevalidation
          || point.eventId !== summary.eventId || point.predecessorEventId !== summary.predecessorEventId
          || point.relationId !== summary.relationId || point.exportRowId !== summary.exportRowId
          || point.enterpriseId !== summary.enterpriseId || point.titleCode !== summary.titleCode
      })) throw new Error('Correspondence changed since summary read')
      eventDetails.value = { ...eventDetails.value, [eventId]: { key, loading: false, error: false, rows: resolved } }
    } catch {
      if (eventKey(eventId) === key && eventDetails.value[eventId]?.key === key && eventRequestIds.get(eventId) === eventRequestId) {
        eventDetails.value = { ...eventDetails.value, [eventId]: { key, loading: false, error: true, rows: prior?.key === key ? prior.rows : null } }
      }
    }
  }

  async function load() {
    const current = ++requestId
    const id = toValue(enterpriseId)
    if (ownerId !== id) {
      rows.value = []
      ready.value = false
      eventDetails.value = {}
      eventRequestIds.clear()
      eventReads.clear()
    }
    ownerId = id
    if (id == null) {
      loading.value = false
      error.value = false
      return false
    }
    loading.value = true
    error.value = false
    try {
      const collected: CorrespondenceSummary[] = []
      const seen = new Set<number>()
      let total: number | undefined
      for (let page = 1; ; page++) {
        const result = await $fetch<CorrespondencePage>('/api/roster/correspondences', {
          query: { enterpriseId: id, view: 'summary', page, pageSize: 200 },
        })
        if (current !== requestId) return false
        if (!Array.isArray(result?.rows) || result.page !== page || result.pageSize !== 200
          || !Number.isSafeInteger(result.total) || result.total < 0
          || (total !== undefined && total !== result.total)
          || result.rows.length !== Math.min(200, Math.max(0, result.total - (page - 1) * 200))) {
          throw new Error('Incomplete correspondence page')
        }
        total = result.total
        for (const row of result.rows) {
          if (seen.has(row.id)) throw new Error('Repeated correspondence row')
          seen.add(row.id)
        }
        collected.push(...result.rows)
        if (collected.length === total) break
      }
      if (current === requestId) {
        rows.value = collected
        ready.value = true
        return true
      }
    } catch {
      if (current === requestId) error.value = true
    } finally {
      if (current === requestId) loading.value = false
    }
    return false
  }

  useCorrespondenceReadback(async () => {
    if (toValue(enterpriseId) == null) return true
    const events = Object.keys(eventDetails.value).map(Number)
    if (!await load()) return false
    const complete = (id: number) => detailsForEvent(id) !== null && !detailLoadingForEvent(id) && !detailErrorForEvent(id)
    if (activeEventId === undefined) {
      await Promise.all(events.map(id => loadEvent(id)))
      return events.every(complete)
    }
    // Review's watcher may already own this point read. Join its completion,
    // and follow an explicit selection change without waiting on abandoned UI.
    for (;;) {
      const id = toValue(activeEventId)
      if (id == null) return true
      const key = eventKey(id)
      let changed!: () => void
      const selectionChanged = new Promise<void>(resolve => { changed = resolve })
      const stop = watch(() => toValue(activeEventId), changed, { flush: 'sync' })
      try { await Promise.race([loadEvent(id), selectionChanged]) }
      finally { stop() }
      if (toValue(activeEventId) !== id || eventKey(id) !== key || detailLoadingForEvent(id)) continue
      return complete(id)
    }
  })

  watch(() => toValue(enterpriseId), () => { void load() }, { immediate: true })

  return { rows, loading, error, ready, reload: load, detailsForEvent, detailLoadingForEvent, detailErrorForEvent, loadEvent }
}
