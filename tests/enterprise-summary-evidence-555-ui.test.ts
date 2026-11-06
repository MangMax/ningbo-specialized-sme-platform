// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import EnterprisePage from '../pages/enterprises/[id].vue'
import TitleBadge from '../components/TitleBadge.vue'
import EventChip from '../components/EventChip.vue'
import SourceChip from '../components/SourceChip.vue'

const state = vi.hoisted(() => ({ detail: null as any }))
vi.mock('@pinia/colada', () => ({ useQuery: (options: { key: () => string[] }) => ({
  data: ref(options.key()[0] === 'roster-enterprise' ? state.detail : { rows: [] }),
  isLoading: ref(false), error: ref(null), refetch: vi.fn(),
}) }))
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
    aliases: [], records: [{ id: 1, titleCode: 'specialized_sme', source: 'jxj', district: null, lifecycle: { firstRecognitionYear: 2021, dueYear: 2027, needsReview: false } }],
    events: [{ id: 10, recordId: 1, eventType: 'award', year: 2021, batchSeq: 1, decidedYear: null, reviewOutcome: null }],
    evidence: [], platform: { queries: [], relations: [] },
    qualificationAssessment: { asOf: '2026-11-06T00:00:00.000Z', titles: [{
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
async function openDetail() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/enterprises/:id', component: EnterprisePage }, { path: '/preview', component: { template: '<p>原文件预览</p>' } },
  ] })
  await router.push('/enterprises/91')
  view = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: {
    plugins: [router], components: { TitleBadge, EventChip, SourceChip },
    stubs: { NuxtLink: RouterLink, PageHeader: true, FilePreviewDialog: true },
  } })
  await flushPromises()
  return router
}
it('shows assessed qualification and time beside recognition and review arrangements before expanding basis', async () => {
  await openDetail()
  const summary = view!.get('[aria-label="称号与复核安排"]')
  expect(summary.text()).toContain('当前资格：已到期')
  expect(summary.text()).toContain('评估时点：2026-11-06T00:00:00.000Z')
  expect(summary.text()).toContain('首次认定 2021')
  expect(summary.text()).toContain('下次复核 2027')
  expect(summary.text()).not.toContain('正式复核未通过')
  await summary.findAll('button').find(button => button.text() === '资格依据')!.trigger('click')
  await flushPromises()
  expect(summary.text()).toContain('正式复核未通过')
})
it('keeps qualification unknown without assessment despite a future review arrangement', async () => {
  delete state.detail.qualificationAssessment
  await openDetail()
  const summary = view!.get('[aria-label="称号与复核安排"]')
  expect(summary.text()).toContain('当前资格：未知（尚无评估结果）')
  expect(summary.text()).toContain('评估时点：未知')
  expect(summary.text()).toContain('下次复核 2027')
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
  expect(router.currentRoute.value.query).toEqual({ file: 'jxj/2021/认定公布文件.pdf', page: '8', back: '/enterprises/91' })
  router.back()
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/enterprises/91')
  const returned = view!.get('#record-event-10')
  expect(returned.findAll('[data-testid="official-evidence"]')).toHaveLength(2)
  expect(returned.findAll('button').find(button => button.text() === '来源记录')!.attributes('aria-expanded')).toBe('false')
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
  expect(view!.text()).toContain('平台接口出处暂未读取')
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
  expect(sources[3]!.findAll('a,button')).toHaveLength(0)
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
