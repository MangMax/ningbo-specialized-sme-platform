// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonPage from '../pages/comparison.vue'
import TablePagination from '../components/TablePagination.vue'

const row = (id = 7) => ({
  enterpriseId: id, name: `合成企业${id}`, nameNorm: `合成企业${id}`, uscc: null, district: '海曙区',
  titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: false, evidenceIncluded: false,
  detailUrl: `/api/comparison?view=full&enterpriseId=${id}&title=specialized_sme&direction=missing_in_miit&showCurated=true`,
  explanation: null,
  platform: { aliasCount: 2, confirmedAliasCount: 1, queryCount: 1, sourceRelationCount: 203,
    disposition: { explanationId: 1, status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: null, evidenceQueryId: 8, evidenceRelationId: null } },
})
const envelope = (rows = [row()]) => ({ view: 'summary', rows, total: 51, counts: {}, curatedCounts: {}, platform: { withEvidence: 51, withExplanation: 51, withoutExplanation: 0 }, reconcile: { generatedAt: null, matched: 0 } })
let wrapper: ReturnType<typeof mount> | undefined
let fetch: ReturnType<typeof vi.fn>
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); sessionStorage.clear() })
async function start(path = '/comparison?mode=legacy') {
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('$fetch', fetch)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/comparison', component: ComparisonPage }] })
  await router.push(path)
  wrapper = mount(RouterView, { attachTo: document.body, global: {
    plugins: [router, createPinia(), PiniaColada],
    components: { TablePagination },
    stubs: { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot/></a>' }, RecordComparisonPanel: true, EvidenceReviewList: true, PageHeader: true, TableLoadingStatus: true, TableFailureState: true },
  } })
  await flushPromises()
  return router
}
it('requests summary on initial load, pagination and filters without eager enterprise or full evidence reads', async () => {
  fetch = vi.fn(async (url: string, options?: { query?: { view?: string } }) => {
    if (url.startsWith('/api/roster/')) return { titleAssessments: [] }
    if (options?.query?.view === 'summary') return envelope()
    return envelope([{ ...row(), evidence: {}, platform: { aliases: [], queries: [], disposition: row().platform.disposition } } as any])
  })
  await start()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]).toEqual(['/api/comparison', { query: expect.objectContaining({ view: 'summary', page: 1, pageSize: 25 }) }])
  expect(wrapper!.text()).toContain('平台未更新')
  expect(wrapper!.text()).toContain('平台时点')
  wrapper!.findComponent(TablePagination).vm.$emit('update:page', 2)
  await flushPromises()
  expect(fetch.mock.calls.at(-1)).toEqual(['/api/comparison', { query: expect.objectContaining({ view: 'summary', page: 2 }) }])
  await wrapper!.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]').setValue('合成')
  await flushPromises()
  expect(fetch.mock.calls.at(-1)).toEqual(['/api/comparison', { query: expect.objectContaining({ view: 'summary', page: 1, q: '合成' }) }])
  expect(fetch.mock.calls.every(([url]) => url === '/api/comparison')).toBe(true)
})

const full = (id = 7) => ({ ...row(id), evidence: { currentCity: '杭州市', regStatus: '存续' }, note: '保留核实备注',
  platform: { aliases: [{ id: 1, name: '合成曾用名', nameNorm: '合成曾用名', verificationStatus: 'confirmed' }], queries: [], relationCount: 0,
    disposition: { ...row(id).platform.disposition, reasonNote: '平台时点原始说明', measureNote: '保留配对措施', movedIn: null } } })
function expand() { return wrapper!.findAll('button').find(button => button.text() === '展开原因、记录与备注')!.trigger('click') }
it('loads advertised full details only on expansion and shows loading, failure and explicit retry without replacing list state', async () => {
  let reject!: (reason: Error) => void
  fetch = vi.fn((url: string) => {
    if (url === '/api/comparison') return Promise.resolve(envelope())
    if (url === row().detailUrl) return new Promise((_, no) => { reject = no })
    if (url.startsWith('/api/roster/enterprises/')) return Promise.resolve({ titleAssessments: [] })
    throw Error(`Unexpected request ${url}`)
  })
  await start('/comparison?mode=legacy&page=2&q=合成')
  await expand()
  await flushPromises()
  expect(fetch.mock.calls.filter(([url]) => url === row().detailUrl)).toHaveLength(1)
  expect(document.body.textContent).toContain('正在读取完整原因与证据')
  expect(document.body.textContent).not.toContain('尚无平台查询记录')
  reject(Error('synthetic offline'))
  await flushPromises()
  expect(document.body.textContent).toContain('完整原因与证据读取失败')
  fetch.mockImplementation(async (url: string) => url === row().detailUrl ? { rows: [full()] } : { titleAssessments: [] })
  const retry = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('重试读取详情'))!
  retry.click()
  await flushPromises()
  expect(document.body.textContent).toContain('保留核实备注')
  document.querySelector<HTMLButtonElement>('[data-testid="platform-evidence-details-toggle"]')!.click()
  await flushPromises()
  expect(document.body.textContent).toContain('合成曾用名')
  expect(document.body.textContent).toContain('查看认定信息与公布出处')
  expect(wrapper!.findComponent(TablePagination).props('page')).toBe(2)
  expect(wrapper!.get('input[aria-label="搜索企业名称、已确认曾用名或统一社会信用代码"]').element).toHaveProperty('value', '合成')
  expect(fetch.mock.calls.filter(([url]) => url === row().detailUrl)).toHaveLength(2)
})

it('restores legacy filters and page from the return URL and keeps them when opening and closing details', async () => {
  fetch = vi.fn(async (url: string) => url === '/api/comparison' ? envelope() : url.startsWith('/api/comparison?') ? { rows: [full()] } : { titleAssessments: [] })
  const router = await start('/comparison?mode=legacy&page=2&pageSize=25&q=合成&district=海曙区&showCurated=true')
  expect(fetch.mock.calls[0]).toEqual(['/api/comparison', { query: expect.objectContaining({ view: 'summary', page: 2, q: '合成', district: '海曙区', showCurated: true }) }])
  const originalPath = router.currentRoute.value.fullPath
  await expand()
  await flushPromises()
  const link = Array.from(document.querySelectorAll('a')).find(anchor => anchor.textContent === '查看认定信息与公布出处')!
  expect(link.getAttribute('href')).toContain(encodeURIComponent(originalPath))
  document.querySelector<HTMLButtonElement>('[data-testid="comparison-row-details"] [data-slot="dialog-close"]')!.click()
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(originalPath)
  expect(wrapper!.findComponent(TablePagination).props('page')).toBe(2)
  expect(fetch.mock.calls.filter(([url]) => url === '/api/comparison')).toHaveLength(1)
})

it.each(['查看认定信息与公布出处', '查看决定历史与复核'])('captures the actual list table and window offsets from portaled departure %s', async (label) => {
  fetch = vi.fn(async (url: string) => url === '/api/comparison' ? envelope() : url.startsWith('/api/comparison?') ? { rows: [full()] } : { titleAssessments: [] })
  const router = await start('/comparison?mode=legacy&page=2&q=合成')
  const scroller = wrapper!.get('[data-evidence-return-scroll-container]').element as HTMLElement
  scroller.scrollLeft = 173
  scroller.scrollTop = 91
  vi.stubGlobal('scrollY', 428)
  const back = router.currentRoute.value.fullPath
  await expand()
  await flushPromises()
  const link = Array.from(document.querySelectorAll('a')).find(anchor => anchor.textContent === label)!
  expect(scroller.contains(link)).toBe(false)
  link.addEventListener('click', event => event.preventDefault())
  link.click()
  await flushPromises()
  const saved = JSON.parse(sessionStorage.getItem('roster:evidence-preview-return')!)
  expect(saved).toContainEqual({ back, scrollY: 428, scrollLeft: 173, scrollTop: 91 })
})

it('normalizes initial and restored legacy route filters with the same defaults and bounds', async () => {
  fetch = vi.fn(async () => envelope())
  const router = await start('/comparison?mode=legacy&direction=invalid&page=-5&pageSize=999&q=first&showCurated=true')
  expect(fetch.mock.calls[0]![1].query).toEqual({ view: 'summary', title: 'specialized_sme', direction: 'missing_in_miit', page: 1, pageSize: 200, q: 'first', district: '', showCurated: true })
  await router.push('/comparison?mode=legacy&title=innovative_sme&direction=extra_in_miit&page=3.8&pageSize=0&q=second&district=海曙区&showCurated=false')
  await flushPromises()
  expect(fetch.mock.calls.at(-1)![1].query).toEqual({ view: 'summary', title: 'innovative_sme', direction: 'extra_in_miit', page: 3, pageSize: 25, q: 'second', district: '海曙区', showCurated: false })
})
