// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { buildAnnualProcess } from '../lib/roster/annual-process'
import EventCorrespondenceReview from '../components/record-correspondence/EventCorrespondenceReview.vue'
import EventChip from '../components/EventChip.vue'
import TitleBadge from '../components/TitleBadge.vue'
import SourceChip from '../components/SourceChip.vue'

let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })
const events = [7, 8].map(id => ({ id, recordId: 2, type: 'award', year: 2026, seq: 1, decidedYear: null, reviewOutcome: null, titleCode: 'specialized_sme', source: 'jxj', district: null, evidence: [] }))
const page = (id: number, total = 0) => ({ event: { id, evidence: [] }, rows: [], total, page: 1, pageSize: 50, coverage: { rows: [], total: 0, page: 1, pageSize: 25 }, interfaces: [] })
// The annual panel is a real mounted sibling. Supply its new read-only HTTP
// endpoints without replacing either readback listener or the point loader.
function installFetch(fetch: (...args: any[]) => any) {
  vi.stubGlobal('$fetch', (url: string, options?: any) => {
    if (url.endsWith('/browser-context')) return Promise.resolve({ writeEnabled: false })
    if (url.endsWith('/annual-process')) {
      const eventId = Number(url.split('/')[4])
      const process = buildAnnualProcess({ event: { id: eventId, eventType: 'award', year: 2026, decidedYear: null, reviewOutcome: null, record: { enterpriseId: 1, titleCode: 'specialized_sme', usccRaw: null } }, groups: [], coverage: [] })
      return Promise.resolve({ process, sourceGeneration: 'synthetic-readonly', total: 0, page: options.query.page, pageSize: options.query.pageSize, sourceRefs: {} })
    }
    return fetch(url, options)
  })
}
const openSources = async (id: number) => {
  const trigger = wrapper.get(`#review-event-${id}`).findAll('button').find(button => button.text() === '正式文件与已登记出处')!
  if (trigger.attributes('aria-expanded') === 'false') await trigger.trigger('click')
  await flushPromises()
}
const openEvent = async (id: number) => { await wrapper.get(`#review-event-${id} button[aria-expanded]`).trigger('click'); await flushPromises() }

it('keeps review mount read only and discovers only the explicitly expanded event with no old response leak', async () => {
  let first!: (value: unknown) => void
  const fetch = vi.fn().mockImplementation((url: string, options: any) => {
    if (url.endsWith('/discover')) return options.body.eventId === 7 ? new Promise(resolve => { first = resolve }) : Promise.resolve(page(8))
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 200 })
    throw new Error(url)
  })
  installFetch(fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { global: { components: { EventChip, TitleBadge, SourceChip } }, props: { enterpriseId: 1, events, back: '/enterprises/1?tab=review' } })
  await flushPromises()
  expect(wrapper.text()).toContain('公布事件与平台对应')
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/discover'))).toHaveLength(0)
  await openEvent(7)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/discover')).map(([, options]) => options.body.eventId)).toEqual([7])
  await openEvent(8)
  expect(wrapper.get('#review-event-7 button[aria-expanded]').attributes('aria-expanded')).toBe('false')
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/discover')).map(([, options]) => options.body.eventId)).toEqual([7, 8])
  first(page(7, 99)); await flushPromises()
  expect(wrapper.text()).not.toContain('99 条')
  await wrapper.get('#review-event-8 [data-testid="candidate-disclosure"] button').trigger('click')
  expect(wrapper.text()).toContain('本页可核对项 · 0 项')
  expect(wrapper.text()).toContain('来源记录共 0 条')
  expect(wrapper.text()).toContain('不能据此认定平台无记录')
  await openEvent(8)
  await openEvent(7)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/discover'))).toHaveLength(3)
})

it('restores only the selected event and leaves unsupported events out of the correspondence area', async () => {
  const fetch = vi.fn().mockImplementation((url: string, options: any) => Promise.resolve(url.endsWith('/discover') ? page(options.body.eventId) : { rows: [], total: 0, page: 1, pageSize: 200 }))
  installFetch(fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { global: { components: { EventChip, TitleBadge, SourceChip } }, props: { enterpriseId: 1, events: [...events, { ...events[0]!, id: 9, source: 'miit', type: 'maintain' }], eventId: 8, back: '/enterprises/1?tab=review&reviewEventId=8' } })
  await flushPromises()
  expect(wrapper.find('#review-event-9').exists()).toBe(false)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/discover')).map(([, options]) => options.body.eventId)).toEqual([8])
  await wrapper.setProps({ eventId: 7 }); await flushPromises()
  expect(wrapper.get('#review-event-8 button[aria-expanded]').attributes('aria-expanded')).toBe('false')
  expect(wrapper.get('#review-event-7 button[aria-expanded]').attributes('aria-expanded')).toBe('true')
})

it('refreshes only the currently expanded event points after a decision readback', async () => {
  const summary = [7, 8].map(id => ({ id: id + 10, eventId: id, type: 'event_process', status: 'candidate', role: 'context_only', revision: 1, relationId: id + 20, exportRowId: null, requiresRevalidation: false }))
  const fetch = vi.fn().mockImplementation((url: string, options: any) => {
    if (url.endsWith('/discover')) return Promise.resolve(page(options.body.eventId))
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: summary, total: 2, page: 1, pageSize: 200 })
    return Promise.resolve({ ...summary.find(row => url.endsWith(`/${row.id}`)), relation: { query: {} } })
  })
  installFetch(fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { global: { components: { EventChip, TitleBadge, SourceChip } }, props: { enterpriseId: 1, events, back: '/enterprises/1?tab=review' } })
  await flushPromises(); await openEvent(7); await openEvent(8)
  fetch.mockClear()
  summary.forEach(row => { row.revision = 2 })
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  await refreshCorrespondenceViews(); await flushPromises()
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/17'))).toBe(false)
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/18'))).toBe(true)
})

it('waits for the current event point read and propagates its failure during readback', async () => {
  let revision = 1
  let rejectPoint!: (reason: unknown) => void
  const row = () => ({ id: 17, eventId: 7, type: 'event_process', status: 'candidate', role: 'context_only', revision, relationId: 27, exportRowId: null, requiresRevalidation: false })
  const fetch = vi.fn((url: string) => {
    if (url.endsWith('/discover')) return Promise.resolve(page(7))
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: [row()], total: 1, page: 1, pageSize: 200 })
    if (url.endsWith('/17')) return revision === 1 ? Promise.resolve({ ...row(), relation: { query: {} } }) : new Promise((_, reject) => { rejectPoint = reject })
    throw new Error(url)
  })
  installFetch(fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { global: { components: { EventChip, TitleBadge, SourceChip } }, props: { enterpriseId: 1, events, eventId: 7, back: '/enterprises/1?tab=review&reviewEventId=7' } })
  await flushPromises()
  fetch.mockClear(); revision = 2
  let outcome = 'pending'
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  const refresh = refreshCorrespondenceViews().then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await flushPromises()
  const earlyOutcome = outcome
  await openSources(7)
  expect(wrapper.get('#review-event-7').text()).toContain('正在读取对应出处')
  rejectPoint(new Error('delayed current point failed'))
  await flushPromises(); await refresh
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/17'))).toHaveLength(1)
  expect(earlyOutcome).toBe('pending')
  expect(outcome).toBe('rejected')
  expect(wrapper.get('#review-event-7').text()).toContain('对应出处读取失败')
  expect(wrapper.get('#review-event-7').text()).not.toContain('正在读取对应出处')
})

function deferredReadbackReview(eventId: number | null = 7) {
  let revision = 1
  const points = new Map<number, { resolve: (point: unknown) => void; reject: (reason: unknown) => void }>()
  const row = (id: number) => ({ id: id + 10, eventId: id, type: 'event_process', status: 'candidate', role: 'context_only', revision, relationId: id + 20, exportRowId: null, requiresRevalidation: false })
  const point = (id: number) => ({ ...row(id), relation: { sequenceNo: 1, query: { id: id * 100 + revision, interface: 'business_list', queriedAt: '2026-10-23' } } })
  const fetch = vi.fn((url: string, options?: any) => {
    if (url.endsWith('/discover')) return Promise.resolve(page(options.body.eventId))
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: [row(7), row(8)], total: 2, page: 1, pageSize: 200 })
    const id = Number(url.split('/').at(-1)) - 10
    if (id !== 7 && id !== 8) throw new Error(url)
    return revision === 1 ? Promise.resolve(point(id)) : new Promise((resolve, reject) => { points.set(id, { resolve, reject }) })
  })
  installFetch(fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { global: { components: { EventChip, TitleBadge, SourceChip } }, props: { enterpriseId: 1, events, eventId, back: '/enterprises/1?tab=review' } })
  return {
    fetch,
    advance: () => { revision = 2; fetch.mockClear() },
    succeed: (id: number) => { expect(points.has(id)).toBe(true); points.get(id)!.resolve(point(id)) },
    fail: (id: number) => { expect(points.has(id)).toBe(true); points.get(id)!.reject(new Error('deferred point offline')) },
  }
}

it('keeps readback pending until the shared current point succeeds without issuing duplicate reads', async () => {
  const scenario = deferredReadbackReview(); await flushPromises(); scenario.advance()
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  let outcome = 'pending'
  const refresh = refreshCorrespondenceViews().then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await flushPromises()
  expect(outcome).toBe('pending')
  await openSources(7)
  expect(wrapper.get('#review-event-7').text()).toContain('正在读取对应出处')
  scenario.succeed(7); await flushPromises(); await refresh
  expect(outcome).toBe('resolved')
  expect(wrapper.get('#review-event-7').findComponent({ name: 'RecordEventSource' }).props('edges')[0].relation.query.id).toBe(702)
  expect(wrapper.get('#review-event-7').text()).not.toContain('正在读取对应出处')
  expect(scenario.fetch.mock.calls.filter(([url]) => /\/\d+$/.test(url))).toHaveLength(1)
})

it('joins the newly selected event and ignores an abandoned event failure during readback', async () => {
  const scenario = deferredReadbackReview(); await flushPromises(); scenario.advance()
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  let outcome = 'pending'
  const refresh = refreshCorrespondenceViews().then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await flushPromises(); await openEvent(8)
  expect(outcome).toBe('pending')
  await openSources(8)
  expect(wrapper.get('#review-event-8').text()).toContain('正在读取对应出处')
  scenario.succeed(8); await flushPromises()
  const afterCurrentCompleted = outcome
  scenario.fail(7); await flushPromises(); await refresh
  expect(afterCurrentCompleted).toBe('resolved')
  expect(outcome).toBe('resolved')
  expect(wrapper.get('#review-event-8').findComponent({ name: 'RecordEventSource' }).props('edges')[0].relation.query.id).toBe(802)
  expect(wrapper.get('#review-event-8').text()).not.toContain('读取失败')
  expect(wrapper.get('#review-event-8').findComponent({ name: 'RecordEventSource' }).props('edges').map((edge: { relation: { query: { id: number } } }) => edge.relation.query.id)).not.toContain(702)
  expect(scenario.fetch.mock.calls.filter(([url]) => /\/\d+$/.test(url)).map(([url]) => url)).toEqual(['/api/roster/correspondences/17', '/api/roster/correspondences/18'])
})

it('settles an idle review without waiting for an event closed during readback', async () => {
  const scenario = deferredReadbackReview(); await flushPromises(); scenario.advance()
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  let outcome = 'pending'
  const refresh = refreshCorrespondenceViews().then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await flushPromises(); await openEvent(7)
  const afterClose = outcome
  scenario.fail(7); await flushPromises(); await refresh
  expect(afterClose).toBe('resolved')
  expect(outcome).toBe('resolved')
  expect(wrapper.find('[data-testid="record-event-source"]').exists()).toBe(false)
  expect(scenario.fetch.mock.calls.filter(([url]) => /\/\d+$/.test(url))).toHaveLength(1)
})

it('refreshes only summaries while no event is selected', async () => {
  const scenario = deferredReadbackReview(null); await flushPromises(); scenario.advance()
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  await expect(refreshCorrespondenceViews()).resolves.toBeUndefined()
  expect(scenario.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/roster/correspondences'])
  expect(wrapper.find('[data-testid="event-archive-candidates"]').exists()).toBe(false)
})
