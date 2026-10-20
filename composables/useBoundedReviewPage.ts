import { computed, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import type { CursorPage } from '~~/lib/roster/evidence-review-ui'
/** Source/event pages retain their successful scope when a later cursor request fails. */
export function useBoundedReviewPage<T>(namespace: string, url: () => string, scope: () => Record<string, string | number>) {
  const cursor = shallowRef<string | undefined>()
  const history = shallowRef<(string | undefined)[]>([])
  const request = computed(() => ({ url: url(), query: { ...scope(), limit: 25, ...(cursor.value ? { cursor: cursor.value } : {}) } }))
  watch(() => JSON.stringify([url(), scope()]), () => { cursor.value = undefined; history.value = [] })
  const query = useQuery({
    key: () => [namespace, request.value],
    query: async ({ entry }) => {
      const captured = entry.key[1] as typeof request.value
      const pageNumber = history.value.length + 1
      return { ...await $fetch<CursorPage<T>>(captured.url, { query: captured.query }), request: captured, pageNumber }
    },
  })
  const lastSuccess = shallowRef<typeof query.data.value>()
  watch(query.data, data => { if (data) lastSuccess.value = data }, { immediate: true, flush: 'sync' })
  const displayed = computed(() => query.data.value ?? lastSuccess.value)
  const isCurrent = computed(() => !!query.data.value && JSON.stringify(query.data.value.request) === JSON.stringify(request.value) && !query.error.value && !query.isLoading.value)
  /** 失败时保留的目标页；重试与“下一页”都只读取这一页，不改写游标历史。 */
  const targetPage = computed(() => history.value.length + 1)
  const failed = computed(() => !!query.error.value)
  const next = () => {
    if (query.isLoading.value) return
    if (failed.value) { void query.refetch(); return }
    if (isCurrent.value && displayed.value?.nextCursor) {
      history.value = [...history.value, cursor.value]
      cursor.value = displayed.value.nextCursor
    }
  }
  const previous = () => {
    if (query.isLoading.value || !history.value.length) return
    cursor.value = history.value.at(-1)
    history.value = history.value.slice(0, -1)
  }
  const restart = () => { cursor.value = undefined; history.value = []; void query.refetch() }
  return {
    displayed,
    targetPage,
    cursorExpired: computed(() => (query.error.value as { data?: { error?: { code?: string } } })?.data?.error?.code === 'invalid_cursor'),
    loading: query.isLoading,
    error: query.error,
    reload: query.refetch,
    restart,
    next,
    previous,
    canNext: computed(() => !query.isLoading.value && (failed.value ? !!cursor.value : isCurrent.value && !!displayed.value?.nextCursor)),
    canPrevious: computed(() => !query.isLoading.value && history.value.length > 0),
  }
}
