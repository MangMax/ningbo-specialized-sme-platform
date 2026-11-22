// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EnterprisePage from '../../../layers/sme-roster/app/pages/enterprises/[id].vue'
import TitleBadge from '../../../layers/sme-roster/app/components/TitleBadge.vue'
import EventChip from '../../../layers/sme-roster/app/components/EventChip.vue'
import SourceChip from '../../../layers/sme-roster/app/components/SourceChip.vue'

const state = vi.hoisted(() => ({ detail: null as any, query: null as any, queryOptions: null as any }))
vi.mock('@pinia/colada', () => ({ useQuery: (options: { key: () => string[]; query: () => Promise<unknown> }) => {
  const result = { data: ref(options.key()[0] === 'roster-enterprise' ? state.detail : { rows: [] }), isLoading: ref(false), error: ref<Error | null>(null), refetch: vi.fn() }
  if (options.key()[0] === 'roster-enterprise') { state.query = result; state.queryOptions = options }
  return result
} }))
let view: VueWrapper | undefined
let animate: PropertyDescriptor | undefined
beforeEach(() => {
  animate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  Reflect.deleteProperty(Element.prototype, 'animate')
  sessionStorage.clear()
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('$fetch', vi.fn(async () => ({ rows: [], total: 0 })))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
  state.detail = {
    enterprise: { enterpriseId: 91, name: '资格出处验收企业', uscc: '913302001234567890', titles: ['specialized_sme'], firstRecognition: [{ titleCode: 'specialized_sme', year: 2021 }] },
    businessTimeline: { asOf: '2026-11-06T00:00:00.000Z', sources: ['publication', 'recognized_list', 'business_list', 'apply_list'].map(source => ({ source, collectionStatus: 'not_collected', collectedAt: null, events: [] })) },
    aliases: [], records: [{ id: 1, titleCode: 'specialized_sme', source: 'jxj', district: null, lifecycle: { firstRecognitionYear: 2021, dueYear: 2027, needsReview: false } }],
    events: [{ id: 10, recordId: 1, eventType: 'award', year: 2021, batchSeq: 1, decidedYear: null, reviewOutcome: null }],
    evidence: [], platform: { queries: [], relations: [] },
    qualificationAssessment: { asOf: '2026-11-06T19:00:00.000Z', titles: [{
      titleCode: 'specialized_sme', group: 'excluded', effectiveQualification: { status: 'expired', presentationBasis: ['正式复核未通过'], notes: [] },
      officialQualification: { message: '正式资格已经结束', notes: [] }, subject: { message: '主体未终止' }, region: { message: '宁波' },
      platform: { message: '未查询', observations: [] }, correspondence: { message: '无对应' }, completeness: { message: '资料齐备', gaps: [] }, cycles: [],
    }] },
  }
})
afterEach(() => {
  view?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals()
  if (animate) Object.defineProperty(Element.prototype, 'animate', animate)
})
async function openDetail(path = '/enterprises/91') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/enterprises/:id', component: EnterprisePage }, { path: '/preview', component: { template: '<p>原文件预览</p>' } },
  ] })
  await router.push(path)
  view = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: {
    plugins: [router], components: { RosterTitleBadge: TitleBadge, RosterEventChip: EventChip, RosterSourceChip: SourceChip },
    stubs: { NuxtLink: RouterLink, PageHeader: { template: '<header><slot name="breadcrumb" /></header>' }, FilePreviewDialog: true },
  } })
  await flushPromises()
  return router
}
it('shows assessed qualification and time beside recognition and review arrangements before expanding basis', async () => {
  await openDetail()
  const summary = view!.get('[aria-label="称号与复核安排"]')
  expect(summary.text()).toContain('当前资格：已到期')
  expect(summary.text()).toContain('评估时点：2026-11-07 03:00')
  expect(summary.get('time').attributes('datetime')).toBe('2026-11-06T19:00:00.000Z')
  expect(summary.text()).toMatch(/首次认定\s*2021/)
  expect(summary.text()).toMatch(/下次复核\s*2027/)
  expect(summary.text()).not.toContain('正式复核未通过')
  await summary.findAll('button').find(button => button.text() === '资格依据')!.trigger('click')
  await flushPromises()
  expect(summary.text()).toContain('正式复核未通过')
  expect(summary.text().match(/评估时点/g)).toHaveLength(1)
})
it('keeps qualification unknown without assessment despite a future review arrangement', async () => {
  delete state.detail.qualificationAssessment
  await openDetail()
  const summary = view!.get('[aria-label="称号与复核安排"]')
  expect(summary.text()).toContain('当前资格：未知（尚无评估结果）')
  expect(summary.text()).toContain('评估时点：未知')
  expect(summary.text()).toMatch(/下次复核\s*2027/)
})
it('exposes each official source before platform loading and navigates to its exact page', async () => {
  state.detail.evidence = [
    { id: 101, eventId: 10, sourceFile: 'jxj/2021/认定公布文件.pdf', attachment: '附件一 / 名单一', listNo: 6, page: 2 },
    { id: 102, eventId: 10, sourceFile: 'jxj/2021/认定公布文件.pdf', attachment: '附件二 / 名单二', listNo: 6, page: 8 },
  ]
  vi.stubGlobal('$fetch', vi.fn(() => new Promise(() => {})))
  const router = await openDetail()
  const row = view!.get('#record-event-10')
  expect(row.text()).toContain('附件一 / 名单一')
  expect(row.text()).toContain('附件二 / 名单二')
  const sources = row.findAll('[data-testid="official-evidence"]')
  expect(sources).toHaveLength(2)
  expect(sources.map(source => source.text())).toEqual([
    expect.stringContaining('序号 6'), expect.stringContaining('序号 6'),
  ])
  const page = sources[1]!.findAll('a').find(link => link.text() === '第 8 页')!
  expect(page.isVisible()).toBe(true)
  expect(sources[1]!.findAll('a,button').some(action => action.text() === '查看原文件')).toBe(true)
  await page.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/preview')
  expect(router.currentRoute.value.query).toEqual({ file: 'jxj/2021/认定公布文件.pdf', page: '8', back: '/enterprises/91?tab=records&eventId=10' })
  router.back()
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/enterprises/91')
  const returned = view!.get('#record-event-10')
  expect(returned.findAll('[data-testid="official-evidence"]')).toHaveLength(2)
  expect(returned.text()).toContain('正式出处')
})
it('keeps review source facts visible on platform failure and offers links only for available files', async () => {
  state.detail.events[0] = { ...state.detail.events[0], eventType: 'review', decidedYear: 2024, reviewOutcome: 'failed' }
  state.detail.evidence = [
    { id: 101, eventId: 10, sourceFile: 'jxj/pending.pdf', attachment: '附件一', listNo: null, page: null },
    { id: 102, eventId: 10, sourceFile: 'jxj/word.docx', attachment: '附件二', listNo: 2, page: 9 },
    { id: 103, eventId: 10, sourceFile: 'jxj/missing.pdf', attachment: '附件三', listNo: 3, page: 5 },
    { id: 104, eventId: 10, sourceFile: 'jxj/unknown.pdf', attachment: '附件四', listNo: 4, page: 6 },
    { id: 105, eventId: 10, sourceFile: 'jxj/archive.doc', attachment: null, listNo: 5, page: null },
  ]
  vi.stubGlobal('$fetch', vi.fn(async () => { throw new Error('platform unavailable') }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: !/missing|unknown/.test(url), status: url.includes('missing') ? 404 : url.includes('unknown') ? 503 : 200 })))
  await openDetail()
  const row = view!.get('#record-event-10')
  expect(row.text()).toContain('复核不通过')
  expect(view!.text()).not.toContain('平台接口出处暂未读取')
  const sources = row.findAll('[data-testid="official-evidence"]')
  expect(sources).toHaveLength(5)
  expect(sources[0]!.text()).toContain('页码待核')
  expect(sources[0]!.findAll('a').some(a => /第 .* 页/.test(a.text()))).toBe(false)
  expect(sources[1]!.text()).toContain('这类文件没有可复核的页码')
  expect(sources[1]!.findAll('a').some(a => /第 .* 页/.test(a.text()))).toBe(false)
  expect(sources[2]!.text()).toContain('文件不可用')
  expect(sources[2]!.text()).toContain('已记录第 5 页')
  expect(sources[2]!.findAll('a,button')).toHaveLength(0)
  expect(sources[3]!.text()).toContain('暂无法确认文件是否可用')
  expect(sources[3]!.text()).toContain('已记录第 6 页')
  expect(sources[3]!.findAll('a')).toHaveLength(0)
  expect(sources[4]!.get('a').text()).toBe('下载原文件')
  expect(sources[4]!.get('a').attributes('href')).toBe('/api/files/jxj/archive.doc')
})
it('withholds navigation while file availability is being checked and enables it when confirmed', async () => {
  state.detail.evidence = [{ id: 101, eventId: 10, sourceFile: 'jxj/checking.pdf', attachment: null, listNo: 1, page: 3 }]
  let resolveHead!: (result: { ok: boolean; status: number }) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveHead = resolve })))
  await openDetail()
  const source = view!.get('#record-event-10 [data-testid="official-evidence"]')
  expect(source.text()).toContain('正在确认文件可用性')
  expect(source.text()).toContain('已记录第 3 页')
  expect(source.findAll('a,button')).toHaveLength(0)
  resolveHead({ ok: true, status: 200 })
  await flushPromises()
  expect(source.get('a').text()).toBe('第 3 页')
  expect(source.get('a').attributes('href')).toContain('page=3')
})

it('binds a source preview return to the clicked event despite an older event coordinate', async () => {
  state.detail.evidence = [{ id: 101, eventId: 10, sourceFile: 'jxj/source.pdf', attachment: '附件一', listNo: 6, page: 2 }]
  await openDetail('/enterprises/91?tab=records&reviewEventId=11&eventId=11')
  const link = view!.get('#record-event-10').findAll('a').find(a => a.text() === '第 2 页')!
  const preview = new URL(link.attributes('href')!, location.origin)
  const back = new URL(preview.searchParams.get('back')!, location.origin)
  expect(back.searchParams.get('eventId')).toBe('10')
  await link.trigger('click', { button: 0 })
  expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain('"eventId":"10"')
})

it('retains successful detail on refresh failure and retries only on explicit action', async () => {
  await openDetail()
  state.query.error.value = new Error('offline')
  await flushPromises()
  expect(view!.text()).toContain('企业详情更新失败')
  expect(view!.get('#record-event-10').text()).toContain('2021')
  expect(view!.text()).toContain('当前资格：已到期')
  expect(state.query.refetch).not.toHaveBeenCalled()
  await view!.get('[data-testid="table-retry"]').trigger('click')
  expect(state.query.refetch).toHaveBeenCalledTimes(1)
})
it('offers an explicit detail retry after the first read fails', async () => {
  state.detail = null
  await openDetail()
  state.query.error.value = new Error('offline')
  await flushPromises()
  expect(view!.text()).toContain('未能加载企业详情')
  expect(view!.find('#record-event-10').exists()).toBe(false)
  await view!.findAll('button').find(button => button.text() === '重新读取企业详情')!.trigger('click')
  expect(state.query.refetch).toHaveBeenCalledTimes(1)
})

it('opens legacy review links as readonly detail without review requests or a leave lock', async () => {
  const router = await openDetail('/enterprises/91?tab=review&reviewEventId=10&titleCode=specialized_sme&direction=platform_only&impactId=4')
  expect(view!.get('#record-event-10').text()).toContain('2021')
  expect(view!.findAll('form')).toHaveLength(0)
  expect(view!.text()).not.toMatch(/称号核对|核对这一事项|来源变化处理|继续填写|切换并丢弃/)
  expect(vi.mocked($fetch)).not.toHaveBeenCalled()
  vi.mocked($fetch as (url: string) => Promise<unknown>).mockResolvedValueOnce(state.detail)
  await state.queryOptions.query()
  expect(vi.mocked($fetch).mock.calls).toEqual([['/api/roster/enterprises/91']])
  await router.push('/preview')
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/preview')
  expect(view!.text()).toContain('原文件预览')
})

it('retains the current enterprise list filters in the return link', async () => {
  await openDetail('/enterprises/91?tab=review&currentBack=title%3Dspecialized_sme%26page%3D3')
  const breadcrumb = view!.get('nav[aria-label="当前位置"]')
  const back = breadcrumb.get('a')
  expect(back.text()).toBe('优质中小企业')
  expect(back.attributes('href')).toBe('/current-enterprises?title=specialized_sme&page=3')
  expect(breadcrumb.get('[aria-current="page"]').text()).toBe('企业详情')
})
it('opens the published original file in the preview dialog', async () => {
  state.detail.evidence = [{ id: 101, eventId: 10, sourceFile: 'jxj/source.pdf', attachment: '附件一', listNo: 6, page: 2 }]
  await openDetail()
  await view!.get('#record-event-10').findAll('button').find(button => button.text() === '查看原文件')!.trigger('click')
  const dialog = view!.getComponent({ name: 'FilePreviewDialog' })
  expect(dialog.props('open')).toBe(true)
  expect(dialog.props('src')).toBe('/api/files/jxj/source.pdf')
})

it('shows selected platform qualification without internal provenance or obsolete approval warnings', async () => {
  const item = state.detail.qualificationAssessment.titles[0]
  item.effectiveQualification = { status: 'effective', source: { source: 'recognized_list' }, presentationBasis: ['认定目录：上海原名；有效期间：2026-03-06 至 2029-03-05'], notes: ['recognized_list record:8520 version:8217 observation:59219', '缺少已确认认定及资格依据'] }
  item.platform.message = '同主体、称号、周期、时点及覆盖尚需核实'
  item.officialQualification.notes = ['缺少已确认认定及资格依据']
  await openDetail()
  const summary = view!.get('[aria-label="称号与复核安排"]')
  await summary.findAll('button').find(button => button.text() === '资格依据')!.trigger('click')
  await flushPromises()
  expect(summary.text()).toContain('有效企业')
  expect(summary.text()).toContain('认定目录：上海原名；有效期间：2026-03-06 至 2029-03-05')
  expect(summary.text()).not.toMatch(/record:|version:|observation:|缺少已确认认定及资格依据|覆盖尚需核实/)
  expect(summary.text()).not.toContain('当前有效状态：有效企业；正式资格已经结束')
})
