import { describe, expect, it } from 'vitest'
import { shallowRef } from 'vue'
import {
  captureQueryRequest,
  useRetainedQuerySnapshot,
  type QueryRequestSnapshot,
} from '../../../layers/core/app/composables/useRetainedQuerySnapshot'

interface PageParams {
  page: number
  pageSize: number
  q?: string
  titles?: string[]
}

interface PageResult {
  rows: string[]
  total: number
  request: QueryRequestSnapshot<PageParams>
}

function result(request: QueryRequestSnapshot<PageParams>, rows: string[], total: number): PageResult {
  return { rows, total, request }
}

describe('useRetainedQuerySnapshot', () => {
  it('captures page, page size and filters at request start', () => {
    const params: PageParams = { page: 1, pageSize: 25, q: '宁波', titles: ['specialized_sme'] }
    const request = captureQueryRequest('ledger-enterprises', params)

    params.page = 2
    params.pageSize = 50
    params.q = '杭州'
    params.titles?.push('innovative_sme')

    expect(request).toMatchObject({
      page: 1,
      pageSize: 25,
      filters: { q: '宁波', titles: ['specialized_sme'] },
      params: { page: 1, pageSize: 25, q: '宁波', titles: ['specialized_sme'] },
    })
    expect(request.key).toBe(JSON.stringify(['ledger-enterprises', {
      page: 1,
      pageSize: 25,
      q: '宁波',
      titles: ['specialized_sme'],
    }]))
  })

  it('keeps only a settled matching response and reports the old source while the new page fails', () => {
    const request1 = captureQueryRequest('ledger-enterprises', {
      page: 1, pageSize: 25, q: '宁波',
    })
    const request2 = captureQueryRequest('ledger-enterprises', {
      page: 2, pageSize: 25, q: '宁波',
    })
    const data = shallowRef<PageResult | undefined>()
    const loading = shallowRef(false)
    const error = shallowRef<unknown>(new Error('first request failed'))
    const activeRequest = shallowRef<QueryRequestSnapshot<PageParams>>(request1)
    const retained = useRetainedQuerySnapshot<PageParams, PageResult>(data, loading, error, activeRequest)

    expect(retained.displayed.value).toBeUndefined()
    expect(retained.failureDescription.value).toBeUndefined()

    error.value = null
    loading.value = true
    data.value = result(request1, ['page-1-row'], 61)
    loading.value = false
    expect(retained.displayed.value?.request.page).toBe(1)

    activeRequest.value = request2
    loading.value = true
    // Pinia Colada exposes the previous page as placeholder data while pending.
    data.value = result(request1, ['page-1-row'], 61)
    expect(retained.displayed.value?.rows).toEqual(['page-1-row'])
    expect(retained.displayed.value?.request.page).toBe(1)
    expect(retained.isShowingPrevious.value).toBe(true)
    expect(retained.paginationDisabled.value).toBe(true)

    loading.value = false
    error.value = new Error('page 2 failed')
    data.value = undefined
    expect(retained.displayed.value).toMatchObject({ rows: ['page-1-row'], total: 61, request: request1 })
    expect(retained.failureDescription.value).toContain('上次成功的第 1 页')
    expect(retained.failureDescription.value).toContain('第 2 页未加载成功')
    expect(retained.paginationDisabled.value).toBe(true)

    // Retry keeps the failed request identity until a real settled success arrives.
    loading.value = true
    error.value = null
    data.value = result(request2, ['page-2-row'], 61)
    expect(retained.displayed.value?.rows).toEqual(['page-1-row'])
    loading.value = false
    expect(retained.displayed.value).toMatchObject({ rows: ['page-2-row'], total: 61, request: request2 })
    expect(retained.isShowingPrevious.value).toBe(false)
    expect(retained.paginationDisabled.value).toBe(false)

    // A late response from the old key cannot replace the current success.
    data.value = result(request1, ['late-page-1-row'], 61)
    expect(retained.displayed.value?.rows).toEqual(['page-2-row'])
  })
})
