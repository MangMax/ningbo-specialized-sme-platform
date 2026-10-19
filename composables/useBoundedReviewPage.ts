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
  const next = () => { if (isCurrent.value && displayed.value?.nextCursor) { history.value = [...history.value, cursor.value]; cursor.value = displayed.value.nextCursor } }
  const previous = () => { if (isCurrent.value && history.value.length) { cursor.value = history.value.at(-1); history.value = history.value.slice(0, -1) } }
  const restart = () => { cursor.value = undefined; history.value = []; void query.refetch() }
  return { displayed, loading: query.isLoading, error: query.error, reload: query.refetch, restart, next, previous, canNext: computed(() => isCurrent.value && !!displayed.value?.nextCursor), canPrevious: computed(() => isCurrent.value && history.value.length > 0) }
}
