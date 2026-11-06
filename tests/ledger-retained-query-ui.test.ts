// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, disposePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink, useRoute, useRouter } from 'vue-router'
import LedgerPage from '../pages/index.vue'
import TablePagination from '../components/TablePagination.vue'
import TableFailureState from '../components/TableFailureState.vue'
import TableLoadingStatus from '../components/TableLoadingStatus.vue'
import PageHeader from '../components/PageHeader.vue'
import type { EnterpriseListRow } from '../components/EnterpriseListTable.vue'

type Response = { rows: EnterpriseListRow[]; counts: { total: number; titlePairs: number; titles: Record<string, number>; recognitionPairs: number; differences: number } }
const first: Response = {
  rows: [{ enterpriseId: 101, name: '第一页示例企业', uscc: null, district: '海曙区', aliasNames: [], titles: [], firstRecognition: [], difference: { count: 0, status: null, reasonCode: null, anyCurrent: false } }],
  counts: { total: 123, titlePairs: 0, titles: {}, recognitionPairs: 0, differences: 0 },
}
const second: Response = {
  rows: [{ enterpriseId: 202, name: '第二页示例企业', uscc: null, district: '江北区', aliasNames: [], titles: [], firstRecognition: [], difference: { count: 0, status: null, reasonCode: null, anyCurrent: false } }],
  counts: { total: 124, titlePairs: 0, titles: {}, recognitionPairs: 0, differences: 0 },
}
const third: Response = {
  rows: [{ enterpriseId: 303, name: '第三页示例企业', uscc: null, district: '鄞州区', aliasNames: [], titles: [], firstRecognition: [], difference: { count: 0, status: null, reasonCode: null, anyCurrent: false } }],
  counts: { total: 125, titlePairs: 0, titles: {}, recognitionPairs: 0, differences: 0 },
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).reverse().forEach(fn => fn())
  vi.unstubAllGlobals()
})

async function openLedger() {
  const pending: { query: Record<string, unknown>; resolve: (value: Response) => void; reject: (error: Error) => void }[] = []
  // Only the transport is controlled. Colada owns keys, pending/error state and
  // callback execution; the page captures request metadata and retains results.
  vi.stubGlobal('$fetch', (url: string, options?: { query: Record<string, unknown> }) => {
    if (url === '/api/stats') return Promise.resolve({ byYear: [], byFirstRecognitionYear: [] })
    if (url !== '/api/roster/enterprises') throw new Error(`Unexpected request: ${url}`)
    return new Promise<Response>((resolve, reject) => pending.push({ query: structuredClone(options!.query), resolve, reject }))
  })
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useRouter', useRouter)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: LedgerPage }] })
  await router.push('/')
  await router.isReady()
  const pinia = createPinia()
  cleanup.push(() => disposePinia(pinia))
  const wrapper = mount(LedgerPage, {
    global: {
      plugins: [pinia, PiniaColada, router],
      components: { TablePagination, TableFailureState, TableLoadingStatus, PageHeader, NuxtLink: RouterLink },
      // These unrelated actions are outside the list/pager seam. Rows, pager,
      // failure notice, query and snapshot composables are real components.
      stubs: { EnterpriseDrawer: true, EnterpriseDifferenceRefresh: true },
    },
  })
  cleanup.push(() => wrapper.unmount())
  await flushPromises()
  expect(pending[0]!.query).toMatchObject({ page: 1, pageSize: 25 })
  pending[0]!.resolve(first)
  await flushPromises()
  expect(wrapper.get('[data-testid="table-total"]').text()).toBe('共 123 家 · 差异 0 条')
  expectSnapshot(wrapper, '第一页示例企业', '共 123 家 · 差异 0 条', '1')
  return { wrapper, router, pending }
}

function expectSnapshot(wrapper: VueWrapper, name: string, total: string, page: string) {
  expect(wrapper.findAll('[data-testid="enterprise-name-trigger"]').map(row => row.text())).toEqual([name])
  expect(wrapper.get('[data-testid="table-total"]').text()).toBe(total)
  expect(wrapper.get('[data-slot="pagination-item"][aria-current="page"]').text()).toBe(page)
}

describe('enterprise page retained query results', () => {
  it('retains page one rows total and page after page two fails and commits retry together', async () => {
    const { wrapper, pending } = await openLedger()
    await wrapper.get('[aria-label="下一页"]').trigger('click')
    await flushPromises()
    expect(pending[1]!.query).toMatchObject({ page: 2, pageSize: 25 })
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    expectSnapshot(wrapper, '第一页示例企业', '共 123 家 · 差异 0 条', '1')
    pending[1]!.reject(new Error('controlled page two failure'))
    await flushPromises()
    expectSnapshot(wrapper, '第一页示例企业', '共 123 家 · 差异 0 条', '1')
    expect(wrapper.get('[data-testid="table-failure-state"]').text()).toContain('显示上次成功的第 1 页；当前筛选请求的第 2 页未加载成功。')
    await wrapper.get('[data-testid="table-retry"]').trigger('click')
    await flushPromises()
    expect(pending[2]!.query).toMatchObject({ page: 2, pageSize: 25 })
    expectSnapshot(wrapper, '第一页示例企业', '共 123 家 · 差异 0 条', '1')
    pending[2]!.resolve(second)
    await flushPromises()
    expectSnapshot(wrapper, '第二页示例企业', '共 124 家 · 差异 0 条', '2')
    expect(wrapper.find('[data-testid="table-failure-state"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeUndefined()
  })
  it('keeps page three visible when a superseded page two response arrives late', async () => {
    const { wrapper, router, pending } = await openLedger()
    await wrapper.get('[aria-label="下一页"]').trigger('click')
    await flushPromises()
    expect(pending[1]!.query).toMatchObject({ page: 2, pageSize: 25 })
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    expectSnapshot(wrapper, '第一页示例企业', '共 123 家 · 差异 0 条', '1')
    // Loading disables the pager. A public deep link supersedes this request.
    await router.push({ path: '/', query: { page: '3' } })
    await flushPromises()
    expect(pending[2]!.query).toMatchObject({ page: 3, pageSize: 25 })
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    pending[2]!.resolve(third)
    await flushPromises()
    expectSnapshot(wrapper, '第三页示例企业', '共 125 家 · 差异 0 条', '3')
    pending[1]!.resolve(second)
    await flushPromises()
    expectSnapshot(wrapper, '第三页示例企业', '共 125 家 · 差异 0 条', '3')
    expect(wrapper.find('[data-testid="table-failure-state"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeUndefined()
  })

})
