// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import EventCorrespondenceReview from '../components/record-correspondence/EventCorrespondenceReview.vue'

let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })
const events = [7, 8].map(id => ({ id, recordId: 2, type: 'award', year: 2026, seq: 1, decidedYear: null, reviewOutcome: null, titleCode: 'specialized_sme', source: 'jxj', district: null, evidence: [] }))
const page = (id: number, total = 0) => ({ event: { id, evidence: [] }, rows: [], total, page: 1, pageSize: 50, coverage: { rows: [], total: 0, page: 1, pageSize: 25 }, interfaces: [] })
const openEvent = async (id: number) => { await wrapper.get(`#review-event-${id} button[aria-expanded]`).trigger('click'); await flushPromises() }

it('keeps review mount read only and discovers only the explicitly expanded event with no old response leak', async () => {
  let first!: (value: unknown) => void
  const fetch = vi.fn().mockImplementation((url: string, options: any) => {
    if (url.endsWith('/discover')) return options.body.eventId === 7 ? new Promise(resolve => { first = resolve }) : Promise.resolve(page(8))
    if (url.endsWith('/correspondences')) return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 200 })
    throw new Error(url)
  })
  vi.stubGlobal('$fetch', fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { props: { enterpriseId: 1, events, back: '/enterprises/1?tab=review' } })
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
  expect(wrapper.text()).toContain('平台候选 · 0 条')
  expect(wrapper.text()).toContain('不能据此认定平台无记录')
  await openEvent(8)
  await openEvent(7)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/discover'))).toHaveLength(3)
})

it('restores only the selected event and leaves unsupported events out of the correspondence area', async () => {
  const fetch = vi.fn().mockImplementation((url: string, options: any) => Promise.resolve(url.endsWith('/discover') ? page(options.body.eventId) : { rows: [], total: 0, page: 1, pageSize: 200 }))
  vi.stubGlobal('$fetch', fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { props: { enterpriseId: 1, events: [...events, { ...events[0]!, id: 9, source: 'miit', type: 'maintain' }], eventId: 8, back: '/enterprises/1?tab=review&reviewEventId=8' } })
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
  vi.stubGlobal('$fetch', fetch); vi.stubGlobal('useState', () => ref(false))
  wrapper = mount(EventCorrespondenceReview, { props: { enterpriseId: 1, events, back: '/enterprises/1?tab=review' } })
  await flushPromises(); await openEvent(7); await openEvent(8)
  fetch.mockClear()
  summary.forEach(row => { row.revision = 2 })
  const { refreshCorrespondenceViews } = await import('../composables/useCorrespondenceReadback')
  await refreshCorrespondenceViews(); await flushPromises()
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/17'))).toBe(false)
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/18'))).toBe(true)
})
