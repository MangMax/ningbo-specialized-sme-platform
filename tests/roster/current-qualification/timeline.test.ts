// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import CurrentQualificationTimeline from '../../../components/CurrentQualificationTimeline.vue'
import type { TimelineEventFacts } from '../../../lib/roster/enterprise-timeline'

const award = (year: number | null): TimelineEventFacts => ({ eventType: 'award', year, decidedYear: year, batchSeq: 1, reviewOutcome: null })
const review = (decidedYear: number | null, reviewOutcome: string | null = 'passed'): TimelineEventFacts => ({ eventType: 'review', year: 2021, decidedYear, batchSeq: 1, reviewOutcome })

it('orders actual recognition and review steps chronologically and merges duplicate source events', () => {
  const wrapper = mount(CurrentQualificationTimeline, { props: { events: [review(2024), award(2021), award(2021), { ...award(2026), eventType: 'maintenance' }] } })
  expect(wrapper.get('ol').attributes('aria-label')).toBe('认定与复核时间线')
  expect(wrapper.findAll('li').map(item => item.text())).toEqual(['2021 认定', '→2024 复核'])
  wrapper.unmount()
})

it('does not turn the original award year into a missing review year', () => {
  const wrapper = mount(CurrentQualificationTimeline, { props: { events: [review(null, null), award(2021)] } })
  expect(wrapper.findAll('li').map(item => item.text())).toEqual(['2021 认定', '→年份未记录 复核（结论待核）'])
  wrapper.unmount()
})

it('keeps failed and unrecognized review outcomes explicit', () => {
  const wrapper = mount(CurrentQualificationTimeline, { props: { events: [review(2024, 'failed'), review(2025, 'legacy')] } })
  expect(wrapper.findAll('li').map(item => item.text())).toEqual(['2024 复核（未通过）', '→2025 复核（未知结论：legacy）'])
  wrapper.unmount()
})

it('shows an empty history without inventing a recognition step and updates when the selected title changes', async () => {
  const wrapper = mount(CurrentQualificationTimeline, { props: { events: [] } })
  expect(wrapper.text()).toBe('暂无认定与复核记录')
  expect(wrapper.find('ol').exists()).toBe(false)
  await wrapper.setProps({ events: [award(2025)] })
  expect(wrapper.findAll('li').map(item => item.text())).toEqual(['2025 认定'])
  wrapper.unmount()
})

it('does not describe an old response without history fields as an empty history', () => {
  const wrapper = mount(CurrentQualificationTimeline)
  expect(wrapper.text()).toBe('认定与复核记录请查看详情')
  expect(wrapper.text()).not.toContain('暂无')
  wrapper.unmount()
})

it('loads all sources only on opening and isolates a later enterprise from a pending response', async () => {
  const { vi } = await import('vitest')
  const { flushPromises } = await import('@vue/test-utils')
  let resolve!: (value: unknown) => void
  const fetch = vi.fn(() => new Promise(r => { resolve = r }))
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(CurrentQualificationTimeline, { props: { enterpriseId: 1, events: [] } })
  try {
    expect(fetch).not.toHaveBeenCalled()
    await wrapper.get('button').trigger('click')
    expect(fetch).toHaveBeenCalledWith('/api/roster/enterprises/1')
    await wrapper.setProps({ enterpriseId: 2 })
    resolve({ qualificationAssessment: { asOf: '2026-11-16' }, businessTimeline: { sources: [] } })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PlatformRecords' }).exists()).toBe(false)
  } finally { wrapper.unmount(); vi.unstubAllGlobals() }
})

it('retains a successful timeline after refresh failure and offers explicit retry', async () => {
  const { vi } = await import('vitest')
  const { flushPromises, DOMWrapper } = await import('@vue/test-utils')
  const fetch = vi.fn().mockResolvedValueOnce({ qualificationAssessment: { asOf: '2026-11-16' }, businessTimeline: { sources: [] } }).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ qualificationAssessment: { asOf: '2026-11-17' }, businessTimeline: { sources: [] } })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(CurrentQualificationTimeline, { attachTo: document.body, props: { enterpriseId: 1 }, global: { stubs: { Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' }, DialogContent: { template: '<div><slot /></div>' }, DialogHeader: { template: '<div><slot /></div>' }, DialogTitle: { template: '<h2><slot /></h2>' }, DialogDescription: { template: '<p><slot /></p>' } } } })
  try {
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('2026-11-16')
    // Close and reopen through the public dialog model to request a fresh read.
    wrapper.findComponent({ name: 'Dialog' }).vm.$emit('update:open', false)
    await flushPromises()
    await new DOMWrapper(wrapper.element).find('button').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('读取失败')
    expect(wrapper.text()).toContain('2026-11-16')
    const retry = wrapper.findAll('button').find(b => b.text() === '重试读取业务记录')!
    await retry.trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('2026-11-17')
  } finally { wrapper.unmount(); vi.unstubAllGlobals() }
})
