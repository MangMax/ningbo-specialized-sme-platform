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
  async function loadEvent(eventId: number, force = false) {
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
      if (ownerId !== retryOwner || eventRequestIds.get(eventId) !== retryId) return
      if (!refreshed) {
        eventDetails.value = { ...eventDetails.value, [eventId]: { key: retryKey, loading: false, error: true, rows: prior?.key === retryKey ? prior.rows : null } }
        return
      }
    }
    const selected = eventRows(eventId)
    if (!selected.length) return
    const key = eventKey(eventId)
    const prior = eventDetails.value[eventId]
    if (!force && prior?.key === key && (prior.loading || prior.rows)) return
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
    // The event review surface refreshes only its current selection. Records
    // callers retain their existing multi-disclosure readback behavior.
    const active = activeEventId === undefined ? undefined : toValue(activeEventId)
    const events = active === undefined ? Object.keys(eventDetails.value).map(Number) : active == null ? [] : [active]
    if (!await load()) return false
    await Promise.all(events.map(id => loadEvent(id)))
    return events.every(id => !detailErrorForEvent(id))
  })

  watch(() => toValue(enterpriseId), () => { void load() }, { immediate: true })

  return { rows, loading, error, ready, reload: load, detailsForEvent, detailLoadingForEvent, detailErrorForEvent, loadEvent }
}
