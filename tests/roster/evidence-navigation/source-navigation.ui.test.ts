// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EnterprisePage from '../../../pages/enterprises/[id].vue'
import SourceChip from '../../../components/SourceChip.vue'
import EventChip from '../../../components/EventChip.vue'
import SourceReader from '../../../components/record-correspondence/SourceReader.vue'
import ComparisonEventRow from '../../../components/record-correspondence/ComparisonEventRow.vue'
import ComparisonEvidence from '../../../components/record-correspondence/ComparisonEvidence.vue'
import type { RecordComparisonResult } from '../../../lib/roster/record-comparison-view'

const query = { id: 20, interface: 'business_list', queryKey: 'synthetic', rdjb: '2', queriedAt: '2026-10-18', status: 'success', failureReason: null, relationCount: 1 }
const relation = { id: 30, queryId: 20, enterpriseId: 91, sequenceNo: 1, nameRaw: '合成企业', status: '终审不通过', rawFields: {}, query }
const record = { id: 1, enterpriseId: 91, titleCode: 'specialized_sme', source: 'jxj', district: null, nameRaw: '合成企业' }
const event = { id: 10, recordId: 1, eventType: 'review', year: 2021, batchSeq: 1, decidedYear: 2024, reviewOutcome: 'failed', record, evidence: [], correspondences: [] }
const edge = { id: 1, type: 'event_process', role: 'supports_review', status: 'confirmed', revision: 1, requiresRevalidation: false, eventId: 10, predecessorEventId: null, relationId: 30, exportRowId: null, enterpriseId: 91, titleCode: 'specialized_sme', ruleId: 'fixture', ruleVersion: '1', decidedAt: null, event, relation, exportRow: null }
const detail = { enterprise: { enterpriseId: 91, name: '合成企业', uscc: null }, aliases: [], records: [record], events: [event, { ...event, id: 11 }], evidence: [], platform: { queries: [query], relations: [relation] } }
const pendingState = { data: ref<any>(undefined), isLoading: ref(false), error: ref<Error | null>(null), refetch: vi.fn() }
vi.mock('@pinia/colada', () => ({ useQuery: (options: any) => options.key()[0] === 'evidence-impacts' ? pendingState : ({ data: ref(detail), isLoading: ref(false), error: ref(null) }) }))
const returnTo = '/comparison?mode=record&queryIds=20&exportBatchIds=6&page=2'
const startTo = (eventId: number, withReturn = true) => ({ path: '/enterprises/91', query: { eventId: String(eventId), ...(withReturn ? { returnTo } : {}) } })
const stubs = { NuxtLink: RouterLink, PageHeader: { template: '<header><slot name="breadcrumb" /></header>' }, FilePreviewDialog: true, EnterpriseLaterProcesses: true, TitleBadge: true }
const preventNativeNavigation = (event: Event) => event.preventDefault()
let wrapper: VueWrapper | undefined
let originalAnimate: PropertyDescriptor | undefined
beforeEach(() => {
  pendingState.data.value = undefined; pendingState.isLoading.value = false; pendingState.error.value = null; pendingState.refetch.mockReset()
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

it('keeps source-change loading empty and failed states distinct and retries only that list', async () => {
  pendingState.isLoading.value = true
  const router = await enterprise(10)
  await router.push({ path: '/enterprises/91', query: { tab: 'review' } }); await flushPromises()
  const sourceChanges = () => wrapper!.get('[aria-label="待处理证据变化"]')
  expect(sourceChanges().text()).toContain('正在读取来源变化')
  expect(sourceChanges().text()).not.toContain('暂无待处理来源变化')
  pendingState.isLoading.value = false; pendingState.error.value = new Error('offline'); await flushPromises()
  expect(sourceChanges().text()).toContain('来源变化清单读取失败')
  expect(sourceChanges().text()).not.toContain('暂无待处理来源变化')
  await sourceChanges().findAll('button').find(b => b.text() === '重新加载')!.trigger('click')
  expect(pendingState.refetch).toHaveBeenCalledTimes(1)
  pendingState.error.value = null; pendingState.data.value = { rows: [], nextCursor: null, projectionReady: false }; await flushPromises()
  expect(sourceChanges().text()).toContain('来源变化尚未整理完成')
  expect(sourceChanges().text()).not.toContain('暂无待处理来源变化')
  pendingState.data.value = { rows: [], nextCursor: null, projectionReady: true }; await flushPromises()
  expect(sourceChanges().text()).toContain('暂无待处理来源变化')
  expect(sourceChanges().text()).not.toContain('核对这一项')
})
afterEach(async () => {
  document.removeEventListener('click', preventNativeNavigation)
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
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: { plugins: [router], components: { SourceChip, EventChip }, stubs } })
  await flushPromises()
  return router
}
async function openPlatformSource() {
  const button = wrapper!.findAll('button').find(button => button.text() === '对应事件/出处')!
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
    expect(history.get('#record-event-23').text()).toContain('经信局')
    expect(history.get('#record-event-26').text()).toContain('不表示已持有称号')
    await vi.waitFor(() => expect(history.get('#record-event-25').attributes('data-highlighted')).toBe('true'))
    const sources = wrapper!.get('[aria-label="记录来源"]')
    expect(sources.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['经信局', '工信部'])
    await sources.findAll('[role="tab"]')[1]!.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(wrapper!.find('#record-event-22').exists()).toBe(false)
    expect(wrapper!.get('#record-event-28').text()).toContain('工信部')
    expect(wrapper!.findAll('[aria-label="记录台账"] ol').length).toBe(1)
    await router.push(startTo(28))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper!.get('#record-event-28').attributes('data-highlighted')).toBe('true'))
    await router.push(startTo(23))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper!.get('#record-event-23').attributes('data-highlighted')).toBe('true'))
    expect(sources.findAll('[role="tab"]')[0]!.attributes('aria-selected')).toBe('true')
  })

  it('retains formal sources when a platform point fails and retries the selected event', async () => {
    const { event: _event, relation: _relation, ...summary } = edge
    let pointCalls = 0
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/roster/correspondences') return { rows: [summary], total: 1, page: 1, pageSize: 200 }
      if (url === '/api/roster/correspondences/1') {
        if (++pointCalls === 1) throw new Error('offline')
        return edge
      }
      return { source: event, correspondences: [edge] }
    })
    vi.stubGlobal('$fetch', fetch)
    await enterprise(10)
    const row = wrapper!.get('#record-event-10')
    expect(row.text()).toContain('不能据此判断没有来源')
    expect(wrapper!.findAll('button').some(button => button.text() === '查看正式来源')).toBe(true)
    await row.findAll('button').find(button => button.text() === '重试读取')!.trigger('click')
    await flushPromises()
    expect(pointCalls).toBe(2)
    expect(row.text()).not.toContain('不能据此判断没有来源')
    expect(row.text()).toContain('原行 1 条')
    await wrapper!.findAll('button').find(button => button.text() === '查看正式来源')!.trigger('click')
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/events/10')
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
  it('uses a summary list on the product route and opens the complete selected source after point hydration', async () => {
    const { event: _event, relation: _relation, ...summary } = edge
    const fetch = vi.fn(async (url: string, options?: { query?: Record<string, unknown> }) => {
      if (url === '/api/roster/correspondences') return { rows: [summary], total: 1, page: 1, pageSize: 200 }
      if (url === '/api/roster/correspondences/1') return edge
      if (url === '/api/roster/correspondences/relations/30') return { source: relation, correspondences: [edge] }
      return { source: event, correspondences: [edge] }
    })
    vi.stubGlobal('$fetch', fetch)
    await enterprise(10)
    expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences', { query: { enterpriseId: 91, view: 'summary', page: 1, pageSize: 200 } })
    expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/1')
    expect(wrapper!.text()).toContain('已确认')
    expect(wrapper!.text()).not.toContain('对应出处尚未读取')
    await wrapper!.findAll('button').find(button => button.text() === '正式文件与已登记出处')!.trigger('click')
    await flushPromises()
    await wrapper!.findAll('button').find(button => button.text() === '查看平台业务详情')!.trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/relations/30')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('合成企业')
  })

  it('defaults to records and keeps verification in a separate tab', async () => {
    await enterprise(10, true)
    const tabs = wrapper!.findAll('[aria-label="企业详情内容"] [role="tab"]')
    expect(tabs.map(tab => tab.text())).toEqual(['认定信息与记录 2', '称号核对'])
    expect(tabs.filter(tab => tab.attributes('aria-selected') === 'true').map(tab => tab.text()))
      .toEqual(['认定信息与记录 2'])
    expect(wrapper!.text()).toContain('称号与复核安排')
  })
})

describe('source modal reverse event navigation', () => {
  it.each([{ name: 'same event URL without return target', initial: 10, withReturn: false }, { name: 'same event URL with source query', initial: 10, withReturn: true }, { name: 'different event route reuse', initial: 11, withReturn: true }])('closes and arrives at the event for $name', async ({ initial, withReturn }) => {
    const router = await enterprise(initial, withReturn)
    const page = wrapper!.findComponent(EnterprisePage).vm.$.uid
    const target = wrapper!.get('#record-event-10')
    const collapsible = target.findComponent({ name: 'DisclosurePanel' })
    // Same-URL navigation must also reopen an event the user has collapsed.
    collapsible.vm.$emit('update:open', false)
    await nextTick()
    const scroll = vi.spyOn(target.element, 'scrollIntoView')
    const link = await openPlatformSource()
    expect(link.getAttribute('href')).toBe(router.resolve(startTo(10, withReturn)).href)
    link.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    await settleDialog()
    expect(router.currentRoute.value.fullPath).toBe(router.resolve(startTo(10, withReturn)).fullPath)
    expect(wrapper!.findComponent(EnterprisePage).vm.$.uid).toBe(page)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(collapsible.props('open')).toBe(true)
    // Expanded evidence can be taller than the viewport: keep the event heading in view.
    // Event arrival waits two animation frames and the page-scroll restoration
    // delay. flushPromises alone does not complete those browser tasks.
    await vi.waitFor(() => expect(scroll).toHaveBeenLastCalledWith({ block: 'start' }))
    expect(router.currentRoute.value.query.returnTo).toBe(withReturn ? returnTo : undefined)
  })

  it.each([
    { name: 'control', options: { ctrlKey: true } }, { name: 'command', options: { metaKey: true } },
    { name: 'shift', options: { shiftKey: true } }, { name: 'alt', options: { altKey: true } },
    { name: 'middle button', options: { button: 1 } }, { name: 'new tab target', options: {}, target: '_blank' },
  ])('keeps the current source dialog for $name activation', async ({ options, target }) => {
    const router = await enterprise(11)
    const before = router.currentRoute.value.fullPath
    const link = await openPlatformSource()
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
    wrapper = mount(SourceReader, { props: { kind: 'relation', id: 30, returnTo }, global: { plugins: [router], components: { SourceChip, EventChip }, stubs } })
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
      ? mount(ComparisonEventRow, { props: { row, returnTo }, attachTo: document.body, global: { plugins: [router], components: { SourceChip, EventChip }, stubs } })
      : mount(ComparisonEvidence, { props: { result, returnTo }, attachTo: document.body, global: { plugins: [router], components: { SourceChip, EventChip }, stubs } })
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

describe('single event verification workspace', () => {
  it('opens the same review event from records and returns with its source context and focus', async () => {
    const router = await enterprise(11)
    expect(wrapper!.text()).not.toContain('人工核对平台候选')
    const entry = wrapper!.get('#record-event-11').findAll('button').find(button => button.text() === '核对这一事项')
    expect(entry).toBeDefined()
    await entry!.trigger('click'); await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ tab: 'review', reviewEventId: '11', returnTo })
    expect(router.currentRoute.value.query.eventId).toBeUndefined()
    expect(wrapper!.findAll('[aria-label="查找平台对应候选"]')).toHaveLength(1)
    expect(wrapper!.get('#review-event-11').text()).toContain('原认定 2021 年 · 复核结论 2024 年')
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('review-event-11'))
    await wrapper!.findAll('button').find(button => button.text() === '返回认定记录')!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ tab: 'records', eventId: '11', returnTo })
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('record-event-11'))
    expect(wrapper!.text()).not.toContain('人工核对平台候选')
  })
})

it('protects a correspondence basis on tab, event reselection and same-page navigation without duplicate prompts', async () => {
  installCorrespondenceFixture()
  const router = await enterprise(11)
  const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
    expect(button, text).toBeDefined(); button!.click(); await flushPromises()
  }
  await wrapper!.get('#record-event-11').findAll('button').find(b => b.text() === '核对这一事项')!.trigger('click'); await flushPromises()
  await click('人工核对平台候选'); await click('确认对应')
  const textarea = document.querySelector('textarea')!
  textarea.value = '核对同一复核事项的依据'; textarea.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  await click('关闭')
  await click('返回认定记录')
  expect(document.body.textContent).toContain('切换会关闭核对面板')
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  await click('继续填写')
  await click('确认对应')
  expect(document.querySelector('textarea')!.value).toBe('核对同一复核事项的依据')
  await click('关闭')
  await wrapper!.get('#review-event-10 button[aria-expanded]').trigger('click'); await flushPromises()
  expect(wrapper!.get('#review-event-11 button[aria-expanded]').attributes('aria-expanded')).toBe('true')
  expect(document.body.textContent).toContain('切换会丢弃未提交内容')
  await click('继续填写')
  await router.push(startTo(10)); await flushPromises()
  expect(router.currentRoute.value.query.reviewEventId).toBe('11')
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  await click('继续填写')
  await click('返回认定记录'); await click('切换并丢弃')
  expect(router.currentRoute.value.query.eventId).toBe('11')
})

function installCorrespondenceFixture() {
  vi.stubGlobal('useState', () => ref(true))
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: any) => {
    if (url.endsWith('/discover')) return { event: { ...event, id: options.body.eventId }, rows: [{ edge: { type: 'event_process', eventId: options.body.eventId, relationId: 30, role: 'supports_review' }, evidence: { identity: {}, title: { official: 'specialized_sme', row: 'specialized_sme' }, temporal: {}, process: {}, source: { interface: 'business_list' } }, conflicts: [], existingStatus: null }], total: 1, page: 1, pageSize: 50, coverage: { rows: [], total: 0, page: 1, pageSize: 25 }, interfaces: [] }
    if (url.endsWith('/correspondences')) return { rows: [], total: 0, page: 1, pageSize: 200 }
    if (url.endsWith('/browser-context')) return { writeEnabled: true }
    return { source: url.includes('/relations/') ? relation : event, correspondences: [] }
  }))
}

it('keeps an unresolved correspondence request bound when returning or leaving the enterprise', async () => {
  installCorrespondenceFixture()
  const original = globalThis.$fetch
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options?: any) => {
    if (url.endsWith('browser-preflight')) return { planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 0, audit: 1 } }
    if (url.endsWith('browser-commit')) throw { statusCode: 503 }
    return original(url, options)
  }))
  const router = await enterprise(11)
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!
  const click = async (text: string) => { expect(button(text), text).toBeDefined(); button(text).click(); await flushPromises() }
  await wrapper!.get('#record-event-11').findAll('button').find(b => b.text() === '核对这一事项')!.trigger('click'); await flushPromises()
  await click('人工核对平台候选'); await click('确认对应')
  const input = document.querySelector('textarea')!
  input.value = '保留未知提交请求'; input.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
  await click('提交决定'); await click('关闭'); await click('返回认定记录')
  expect(button('切换并丢弃').disabled).toBe(true)
  expect(router.currentRoute.value.query.reviewEventId).toBe('11')
  await click('继续填写'); await router.push('/'); await flushPromises()
  expect(button('离开并丢弃').disabled).toBe(true)
  await click('继续填写'); await click('确认对应')
  expect(document.querySelector('textarea')!.value).toBe('保留未知提交请求')
  expect(button('重试提交')).toBeDefined()
})

it('keeps unsupported events out of verification and shows its empty state', async () => {
  const originalEvents = detail.events
  try {
    detail.events = [{ ...event, eventType: 'nurture' }]
    const router = await enterprise(10)
    expect(wrapper!.text()).not.toContain('核对这一事项')
    await router.push({ path: '/enterprises/91', query: { tab: 'review' } }); await flushPromises()
    expect(wrapper!.text()).toContain('尚无可核对平台对应的正式公布事件')
    expect(wrapper!.find('[aria-label="查找平台对应候选"]').exists()).toBe(false)
  } finally { detail.events = originalEvents }
})

it('retains the selected review fact and return target when correspondence reads fail', async () => {
  vi.stubGlobal('$fetch', vi.fn(async () => { throw new Error('offline') }))
  const router = await enterprise(11)
  await wrapper!.get('#record-event-11').findAll('button').find(b => b.text() === '核对这一事项')!.trigger('click'); await flushPromises()
  expect(wrapper!.text()).toContain('已登记对应读取失败')
  expect(wrapper!.get('#review-event-11').text()).toContain('复核结论 2024 年')
  expect(wrapper!.get('#review-event-11 button[aria-expanded]').attributes('aria-expanded')).toBe('true')
  expect(router.currentRoute.value.query.returnTo).toBe(returnTo)
  expect(wrapper!.findAll('button').some(b => b.text() === '返回认定记录')).toBe(true)
})
