import { computed, shallowRef, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

export interface QueryPageParams {
  page: number
  pageSize: number
}

export interface QueryRequestSnapshot<P extends QueryPageParams> {
  /** Stable identity built from the query namespace and captured params. */
  key: string
  /** Page and page size belonging to the request which produced this response. */
  page: number
  pageSize: number
  /** Captured filters, excluding pagination fields. */
  filters: Omit<P, 'page' | 'pageSize'>
  /** Exact query params passed to the read API. */
  params: P
}

export interface QueryResultWithRequest<P extends QueryPageParams> {
  request: QueryRequestSnapshot<P>
}

function cloneQueryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneQueryValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneQueryValue(nested)]),
    )
  }
  return value
}

/**
 * Copy query params synchronously before a request starts. Route query params
 * are plain values; cloning nested arrays/objects keeps the response provenance
 * independent from later reactive filter and pagination changes.
 */
export function captureQueryRequest<P extends QueryPageParams>(
  namespace: string,
  params: P,
): QueryRequestSnapshot<P> {
  const capturedParams = cloneQueryValue(params) as P
  const filters = Object.fromEntries(
    Object.entries(capturedParams).filter(([key]) => key !== 'page' && key !== 'pageSize'),
  ) as Omit<P, 'page' | 'pageSize'>

  return {
    key: JSON.stringify([namespace, capturedParams]),
    page: capturedParams.page,
    pageSize: capturedParams.pageSize,
    filters,
    params: capturedParams,
  }
}

/**
 * Retain only settled successful results whose captured identity still matches
 * the active query. Pinia Colada placeholder data is intentionally ignored:
 * it can carry an earlier request through pending state and is cleared on error.
 */
export function useRetainedQuerySnapshot<
  P extends QueryPageParams,
  TData extends QueryResultWithRequest<P>,
>(
  dataSource: MaybeRefOrGetter<TData | undefined>,
  loadingSource: MaybeRefOrGetter<boolean>,
  errorSource: MaybeRefOrGetter<unknown>,
  activeRequestSource: MaybeRefOrGetter<QueryRequestSnapshot<P>>,
) {
  const data = computed(() => toValue(dataSource))
  const loading = computed(() => toValue(loadingSource))
  const error = computed(() => toValue(errorSource))
  const activeRequest = computed(() => toValue(activeRequestSource))
  const lastSuccessful = shallowRef<TData | undefined>(undefined)

  watch(
    [data, loading, error, activeRequest],
    ([result, isLoading, failure, active]) => {
      if (!result || isLoading || failure || result.request.key !== active.key) return
      lastSuccessful.value = result
    },
    { flush: 'sync', immediate: true },
  )

  const displayed = computed(() => lastSuccessful.value)
  const hasCurrentSnapshot = computed(
    () => lastSuccessful.value?.request.key === activeRequest.value.key,
  )
  const isShowingPrevious = computed(
    () => Boolean(lastSuccessful.value) && !hasCurrentSnapshot.value,
  )
  const paginationDisabled = computed(
    () => Boolean(loading.value || error.value || !hasCurrentSnapshot.value),
  )
  const failureDescription = computed(() => {
    const previous = lastSuccessful.value
    const target = activeRequest.value
    if (!error.value || !previous || previous.request.key === target.key) return undefined
    return `显示上次成功的第 ${previous.request.page} 页；当前筛选请求的第 ${target.page} 页未加载成功。`
  })

  return {
    displayed,
    hasCurrentSnapshot,
    isShowingPrevious,
    paginationDisabled,
    failureDescription,
  }
}
