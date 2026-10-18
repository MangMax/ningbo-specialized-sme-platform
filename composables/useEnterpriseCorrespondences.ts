import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { CorrespondenceDetail } from '~~/lib/roster/correspondence-view'

interface CorrespondencePage {
  rows: CorrespondenceDetail[]
  total: number
  page: number
  pageSize: number
}

/**
 * 一家企业的全部对应关系（含已确认、候选、已拒绝/解除、当前参考与后续流程）。
 *
 * 详情页要在每条事件行上就地显示接口出处，逐行请求会变成 N 次往返；
 * 这里按企业一次分页读完，再在页面里按 eventId 分组。
 * 这不是判定：接口仍逐条返回自己的状态，页面只决定「哪些算本事件出处」。
 */
export function useEnterpriseCorrespondences(enterpriseId: MaybeRefOrGetter<number | null>) {
  const rows = ref<CorrespondenceDetail[]>([])
  const loading = ref(false)
  const error = ref(false)
  let requestId = 0
  let ownerId: number | null = null

  async function load() {
    const current = ++requestId
    const id = toValue(enterpriseId)
    if (ownerId !== id) rows.value = []
    ownerId = id
    if (id == null) {
      loading.value = false
      error.value = false
      return
    }
    loading.value = true
    error.value = false
    try {
      const collected: CorrespondenceDetail[] = []
      const seen = new Set<number>()
      let total: number | undefined
      for (let page = 1; ; page++) {
        const result = await $fetch<CorrespondencePage>('/api/roster/correspondences', {
          query: { enterpriseId: id, page, pageSize: 200 },
        })
        if (current !== requestId) return
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
      if (current === requestId) rows.value = collected
    } catch {
      if (current === requestId) error.value = true
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  watch(() => toValue(enterpriseId), () => { void load() }, { immediate: true })

  return { rows, loading, error, reload: load }
}
