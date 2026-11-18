// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import EnterprisePage from '../../../layers/sme-roster/app/pages/enterprises/[id].vue'
import SourceChip from '../../../layers/sme-roster/app/components/SourceChip.vue'
import EventChip from '../../../layers/sme-roster/app/components/EventChip.vue'
import SourceReader from '../../../components/record-correspondence/SourceReader.vue'
import ComparisonEventRow from '../../../components/record-correspondence/ComparisonEventRow.vue'
import ComparisonEvidence from '../../../components/record-correspondence/ComparisonEvidence.vue'
import type { RecordComparisonResult } from '../../../lib/roster/record-comparison-view'

const query = { id: 20, interface: 'business_list', queryKey: 'synthetic', rdjb: '2', queriedAt: '2026-10-18', status: 'success', failureReason: null, relationCount: 1 }
const relation = { id: 30, queryId: 20, enterpriseId: 91, sequenceNo: 1, nameRaw: '合成企业', status: '终审不通过', rawFields: {}, query }
const record = { id: 1, enterpriseId: 91, titleCode: 'specialized_sme', source: 'jxj', district: null, nameRaw: '合成企业' }
const event = { id: 10, recordId: 1, eventType: 'review', year: 2021, batchSeq: 1, decidedYear: 2024, reviewOutcome: 'failed', record, evidence: [], correspondences: [] }
const edge = { id: 1, type: 'event_process', role: 'supports_review', status: 'confirmed', revision: 1, requiresRevalidation: false, eventId: 10, predecessorEventId: null, relationId: 30, exportRowId: null, enterpriseId: 91, titleCode: 'specialized_sme', ruleId: 'fixture', ruleVersion: '1', decidedAt: null, event, relation, exportRow: null }
const businessTimeline = {
  asOf: '2026-11-17',
  sources: [
    { source: 'publication', collectionStatus: 'not_applicable', collectedAt: null, events: [] },
    { source: 'recognized_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
    { source: 'business_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
    { source: 'apply_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
  ],
} satisfies RosterEnterpriseDetail['businessTimeline']
const detail = { enterprise: { enterpriseId: 91, name: '合成企业', uscc: null }, aliases: [], records: [record], events: [event, { ...event, id: 11 }], evidence: [], businessTimeline, platform: { queries: [query], relations: [relation], businessRecords: [] } }
vi.mock('@pinia/colada', () => ({ useQuery: () => ({ data: ref(detail), isLoading: ref(false), error: ref(null), refetch: vi.fn() }) }))
const returnTo = '/comparison?mode=record&queryIds=20&exportBatchIds=6&page=2&q=A%3FB&returnTo=%2Fcurrent-enterprises%3FtitleCode%3Dspecialized_sme%26page%3D4'
const startTo = (eventId: number, withReturn = true) => ({ path: '/enterprises/91', query: { eventId: String(eventId), ...(withReturn ? { returnTo } : {}) } })
const stubs = { NuxtLink: RouterLink, PageHeader: { template: '<header><slot name="breadcrumb" /></header>' }, FilePreviewDialog: true, EnterpriseLaterProcesses: true, RosterTitleBadge: true }
const preventNativeNavigation = (event: Event) => event.preventDefault()
let wrapper: VueWrapper | undefined
let sourceOwner: VueWrapper | undefined
let originalAnimate: PropertyDescriptor | undefined
beforeEach(() => {
  vi.stubGlobal('useState', () => ref(false))
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  Reflect.deleteProperty(Element.prototype, 'animate')
  document.addEventListener('click', preventNativeNavigation)
  sessionStorage.clear()
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useRouter', useRouter)
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => ({ source: url.includes('/events/') ? event : relation, correspondences: [edge] })))
})

afterEach(async () => {
  document.removeEventListener('click', preventNativeNavigation)
  sourceOwner?.unmount()
  sourceOwner = undefined
  wrapper?.unmount()
  wrapper = undefined
  await flushPromises()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
})
async function enterprise(eventId: number, withReturn = true) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/enterprises/:id', component: EnterprisePage }, { path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push(startTo(eventId, withReturn))
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: { plugins: [router], components: { RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
  await flushPromises()
  return router
}
// The normal enterprise route has no source dialog. The supported comparison
// owner opens the actual SourceReader; it shares the router with the detail page.
async function openPlatformSource(router: ReturnType<typeof createRouter>, withReturn = true) {
  const row = { event, record, evidence: [], classification: 'historical_aligned', reasons: [], correspondences: [], platformRows: [{ ...relation, interface: 'business_list' }], laterProcesses: [] } as unknown as RecordComparisonResult['rows'][number]
  sourceOwner = mount(ComparisonEventRow, { props: { row, returnTo: withReturn ? returnTo : '' }, attachTo: document.body,
    global: { plugins: [router], components: { RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
  const button = sourceOwner.findAll('button').find(button => button.text() === '查看原始记录')!
  ;(button.element as HTMLButtonElement).focus()
  await button.trigger('click')
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  return document.querySelector('[role="dialog"] a') as HTMLAnchorElement
}
async function settleDialog() {
  await flushPromises()
  // Reka FocusScope dispatches close autofocus in a nextTick callback.
  await nextTick()
  await flushPromises()
}
describe('per-title complete history', () => {
  const originalRecords = detail.records
  const originalEvents = detail.events
  afterEach(() => { detail.records = originalRecords; detail.events = originalEvents })

  it('groups titles in rank order and retains independent same-year and multi-review events', async () => {
    detail.records = [record, { ...record, id: 2, titleCode: 'innovative_sme' }, { ...record, id: 3, titleCode: 'little_giant' }, { ...record, id: 4, source: 'miit' }]
    const item = (id: number, recordId: number, eventType: string, year: number, decidedYear: number | null = null, reviewOutcome: string | null = null) => ({ ...event, id, recordId, eventType, year, decidedYear, reviewOutcome })
    detail.events = [item(21, 1, 'review', 2021, 2027, 'passed'), item(22, 1, 'award', 2021), item(23, 1, 'review', 2021, 2024, 'failed'), item(24, 1, 'review', 2021, 2024), item(25, 1, 'review', 2021), item(26, 2, 'nurture', 2020), item(27, 3, 'award', 2025), item(28, 4, 'maintain', 2022)] as typeof detail.events
    const router = await enterprise(25)
    const history = wrapper!.get('[aria-label="记录台账"]')
    expect(history.findAll('section > header > h3').map(h => h.text())).toEqual(['专精特新“小巨人”', '专精特新中小企业', '创新型中小企业'])
    const lists = history.findAll('ol')
    expect(lists.map(list => list.findAll('[id^="record-event-"]').map(row => row.attributes('id')))).toEqual([
      ['record-event-27'], ['record-event-22', 'record-event-23', 'record-event-24', 'record-event-21', 'record-event-25'], ['record-event-26'],
    ])
    expect(history.text()).toContain('年份待核')
    expect(history.text()).toContain('同年及未知时点不表示精确先后')
    expect(history.get('#record-event-23').text()).toContain('复核不通过')
    expect(history.get('#record-event-24').text()).toContain('复核结果待核')
    expect(history.get('#record-event-21').text()).toContain('通过')
    expect(history.get('#record-event-23').text()).toContain('原认定 2021 年')
    expect(history.get('#record-event-23').text()).toContain('第 1 批')
    expect(history.get('#record-event-22').text()).toContain('第 1 批')
    expect(history.find('#record-event-28').exists()).toBe(false)
    expect(history.get('#record-event-26').text()).toContain('不表示已持有称号')
    await vi.waitFor(() => expect(history.get('#record-event-25').attributes('data-highlighted')).toBe('true'))
    const sources = wrapper!.get('[aria-label="记录来源"]')
    expect(sources.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['公布资料'])
    expect(wrapper!.get('[aria-label="业务来源"]').findAll('[role="tab"]').map(tab => tab.text())).toEqual(['公布资料', '认定目录', '关联办理', '申报记录'])
    await router.push(startTo(23))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper!.get('#record-event-23').attributes('data-highlighted')).toBe('true'))
    expect(sources.findAll('[role="tab"]')[0]!.attributes('aria-selected')).toBe('true')
  })

  it('retains formal sources and the last successful reader after failure and retries only its target', async () => {
    const router = await enterprise(10)
    let targetCalls = 0
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/relations/31') && ++targetCalls === 1) throw new Error('offline')
      return { source: relation, correspondences: [edge] }
    })
    vi.stubGlobal('$fetch', fetch)
    sourceOwner = mount(SourceReader, { props: { kind: 'relation', id: 30, readOnly: true, returnTo },
      global: { plugins: [router], components: { NuxtLink: RouterLink, RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
    await flushPromises()
    expect(sourceOwner.text()).toContain('合成企业')
    await sourceOwner.setProps({ id: 31 }); await flushPromises()
    expect(sourceOwner.text()).toContain('上次成功读取的出处保留在下方')
    expect(sourceOwner.text()).toContain('合成企业')
    expect(wrapper!.get('#record-event-10').text()).toContain('复核不通过')
    await sourceOwner.findAll('button').find(button => button.text() === '重试读取')!.trigger('click')
    await flushPromises()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/roster/correspondences/relations/30', '/api/roster/correspondences/relations/31', '/api/roster/correspondences/relations/31',
    ])
    expect(sourceOwner.text()).not.toContain('当前来源未更新')
    expect(sourceOwner.text()).toContain('合成企业')
    expect(router.currentRoute.value.query.returnTo).toBe(returnTo)
  })

  it('shows a record without events without inventing a step', async () => {
    detail.events = []
    await enterprise(10)
    const history = wrapper!.get('[aria-label="记录台账"]')
    expect(history.get('h3').text()).toBe('专精特新中小企业')
    expect(history.text()).toContain('该称号暂无事件')
    expect(history.findAll('li')).toHaveLength(0)
  })

  it('shows the no-record state without inventing a title group', async () => {
    detail.records = []; detail.events = []
    await enterprise(10)
    expect(wrapper!.text()).toContain('该企业暂无记录')
    expect(wrapper!.find('[aria-label="记录台账"]').exists()).toBe(false)
  })
})

describe('enterprise detail information architecture', () => {
  it('shows four business sources without a manual verification prerequisite', async () => {
    await enterprise(10, true)
    expect(wrapper!.findAll('[aria-label="业务来源"] [role="tab"]').map(tab => tab.text()))
      .toEqual(['公布资料', '认定目录', '关联办理', '申报记录'])
    expect(wrapper!.get('#record-event-10').text()).toContain('复核不通过')
    expect(wrapper!.text()).not.toContain('核对这一事项')
    expect(wrapper!.text()).not.toContain('称号核对')
  })
})

describe('source modal reverse event navigation', () => {
  it.each([false, true])('closes the source owner and emits its target for the same URL return=%s', async withReturn => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push(startTo(10, withReturn))
    const before = router.currentRoute.value.fullPath
    const link = await openPlatformSource(router, withReturn)
    expect(link.getAttribute('href')).toBe(router.resolve(startTo(10, withReturn)).href)
    const reader = sourceOwner!.getComponent(SourceReader)
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await settleDialog()
    expect(reader.emitted('event-navigate')).toEqual([[10]])
    expect(router.currentRoute.value.fullPath).toBe(before)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('arrives from the real comparison source owner with the complete return context', async () => {
    const row = { event, record, evidence: [], classification: 'historical_aligned', reasons: [], correspondences: [], platformRows: [{ ...relation, interface: 'business_list' }], laterProcesses: [] } as unknown as RecordComparisonResult['rows'][number]
    const comparison = defineComponent({ render: () => h(ComparisonEventRow, { row, returnTo }) })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/comparison', component: comparison }, { path: '/enterprises/:id', component: EnterprisePage }] })
    await router.push('/comparison')
    wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: { plugins: [router], components: { RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
    await wrapper.findAll('button').find(button => button.text() === '查看原始记录')!.trigger('click')
    await flushPromises()
    const link = document.querySelector('[role="dialog"] a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(router.resolve(startTo(10)).href)
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await settleDialog()
    expect(router.currentRoute.value.fullPath).toBe(router.resolve(startTo(10)).fullPath)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.find('#record-event-10 [aria-label="正式公布文件"]').exists()).toBe(true)
    await vi.waitFor(() => expect(scroll).toHaveBeenLastCalledWith({ block: 'start' }))
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('record-event-10'))
  })

  it('reuses the enterprise page and focuses a different event from a deep link', async () => {
    const router = await enterprise(11)
    const page = wrapper!.findComponent(EnterprisePage).vm.$.uid
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('record-event-11'))
    const target = wrapper!.get('#record-event-10')
    const scroll = vi.spyOn(target.element, 'scrollIntoView')
    await router.push(startTo(10)); await flushPromises()
    expect(wrapper!.findComponent(EnterprisePage).vm.$.uid).toBe(page)
    expect(target.find('[aria-label="正式公布文件"]').exists()).toBe(true)
    await vi.waitFor(() => expect(scroll).toHaveBeenLastCalledWith({ block: 'start' }))
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('record-event-10'))
    expect(router.currentRoute.value.query.returnTo).toBe(returnTo)
  })

  it.each([
    { name: 'control', options: { ctrlKey: true } }, { name: 'command', options: { metaKey: true } },
    { name: 'shift', options: { shiftKey: true } }, { name: 'alt', options: { altKey: true } },
    { name: 'middle button', options: { button: 1 } }, { name: 'new tab target', options: {}, target: '_blank' },
  ])('keeps the current source dialog for $name activation', async ({ options, target }) => {
    const router = await enterprise(11)
    const before = router.currentRoute.value.fullPath
    const link = await openPlatformSource(router)
    if (target) link.setAttribute('target', target)
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, ...options }))
    await settleDialog()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(router.currentRoute.value.fullPath).toBe(before)
    expect(link.getAttribute('href')).toBe(router.resolve(startTo(10)).href)
  })

  it('keeps an inline source reader mounted after ordinary event navigation', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/comparison')
    wrapper = mount(SourceReader, { props: { kind: 'relation', id: 30, returnTo }, global: { plugins: [router], components: { RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
    await flushPromises()
    await wrapper.get('a').trigger('click', { button: 0 })
    await flushPromises()
    expect(wrapper.emitted('event-navigate')).toEqual([[10]])
    expect(wrapper.get('[data-testid="record-source-reader"]').text()).toContain('已确认')
    expect(router.currentRoute.value.query.returnTo).toBe(returnTo)
  })

  it.each(['event row', 'comparison evidence'])('closes the %s source owner on event navigation', async (owner) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/comparison')
    const row = { event, record, evidence: [], classification: 'historical_aligned', reasons: [], correspondences: [], platformRows: [{ ...relation, interface: 'business_list' }], laterProcesses: [] } as unknown as RecordComparisonResult['rows'][number]
    const result = { counts: {}, coverage: [], officialCoverage: { reasons: [] }, historicalDecisionUnavailable: [], currentSourceConsistency: { reasons: [], recognizedObservations: [], exportObservations: [] }, platformWithoutOfficial: { rows: [{ relation, qualification: 'unresolved', reasons: [] }], total: 1 }, laterProcessPlatformRows: [] } as unknown as RecordComparisonResult
    wrapper = owner === 'event row'
      ? mount(ComparisonEventRow, { props: { row, returnTo }, attachTo: document.body, global: { plugins: [router], components: { RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
      : mount(ComparisonEvidence, { props: { result, returnTo }, attachTo: document.body, global: { plugins: [router], components: { RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
    if (owner === 'comparison evidence') {
      await wrapper.get('[data-testid="record-platform-unlinked"] [data-slot="accordion-trigger"]').trigger('click')
      await flushPromises()
    }
    await wrapper.findAll('button').find(button => button.text().includes('查看原始记录'))!.trigger('click')
    await flushPromises()
    const link = document.querySelector('[role="dialog"] a') as HTMLAnchorElement
    expect(link).not.toBeNull()
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await settleDialog()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(router.currentRoute.value.query).toMatchObject({ eventId: '10', returnTo })
  })
})


it('ignores a late source success after switching enterprises and keeps the newer result', async () => {
  let resolveOld!: (value: unknown) => void
  const newer = { ...relation, id: 40, enterpriseId: 92, nameRaw: '新企业' }
  vi.stubGlobal('$fetch', vi.fn((url: string) => url.endsWith('/relations/30')
    ? new Promise(resolve => { resolveOld = resolve })
    : Promise.resolve({ source: newer, correspondences: [] })))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/enterprises/91')
  wrapper = mount(SourceReader, { props: { kind: 'relation', id: 30, readOnly: true, returnTo },
    global: { plugins: [router], components: { NuxtLink: RouterLink, RosterSourceChip: SourceChip, RosterEventChip: EventChip }, stubs } })
  await router.push('/enterprises/92')
  await wrapper.setProps({ id: 40 }); await flushPromises()
  expect(wrapper.text()).toContain('新企业')
  resolveOld({ source: relation, correspondences: [edge] }); await flushPromises()
  expect(wrapper.text()).toContain('新企业')
  expect(wrapper.text()).not.toContain('合成企业')
  expect(router.currentRoute.value.path).toBe('/enterprises/92')
})
