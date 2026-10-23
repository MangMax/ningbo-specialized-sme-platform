// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import AnnualProcessTimeline from '../components/record-correspondence/AnnualProcessTimeline.vue'
import type { AnnualTimelineView } from '../lib/roster/annual-process-presentation'

let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })
function view(): AnnualTimelineView {
  return {
    eventId: 7, generation: 'scope-a', title: '专精特新中小企业', matter: '认定', year: 2024,
    latestStepId: 'late', reasons: [], coverage: [], page: 1, pageSize: 25, total: 2,
    qualification: { eventId: 7, generation: 'scope-a', stepId: 'late', status: 'confirmed', reasons: [] },
    steps: [
      { id: 'late', appliedAt: '2024-12-12 12:00:00', status: '终审通过', observedAt: '2026-10-20', businessKey: 'SYNTHETIC-LATE', reasons: [], sources: [{ key: 'g2', interfaceLabel: '业务列表', recordLabel: '业务记录 2 · 版本 3', observations: [{ relationId: 22, queryId: 12, row: 2, queriedAt: '2026-10-20', decision: '已确认', revision: 3 }] }] },
      { id: 'early', appliedAt: '2024-03-01 12:00:00', status: '终审不通过', observedAt: '2026-10-20', businessKey: 'SYNTHETIC-EARLY', reasons: [], sources: [] },
    ],
  }
}
function panel(value = view()) { return mount(AnnualProcessTimeline, { props: { view: value, back: '/enterprises/1?tab=review&reviewEventId=7' } }) }

it('shows both annual businesses in application order with exactly one confirmed final and no early final conflict', () => {
  wrapper = panel()
  const steps = wrapper.findAll('[data-annual-step]')
  expect(steps.map(step => step.attributes('data-annual-step'))).toEqual(['early', 'late'])
  expect(steps[0]!.text()).toContain('终审不通过')
  expect(steps[0]!.text()).not.toContain('冲突')
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
  expect(steps[1]!.find('[data-final-result]').text()).toBe('最终结果')
  expect(wrapper.text()).toContain('申报于 2024-03-01 12:00:00')
  expect(wrapper.text()).toContain('不代表审批完成时间')
  expect(wrapper.get('[data-annual-summary]').text()).toContain('终审通过')
  expect(wrapper.text()).toContain('称号：专精特新中小企业')
  expect(wrapper.text()).toContain('事项：认定')
})

it.each([
  { name: 'eligible candidate', status: 'eligible', eventId: 7, generation: 'scope-a' },
  { name: 'other event', status: 'confirmed', eventId: 8, generation: 'scope-a' },
  { name: 'old generation', status: 'confirmed', eventId: 7, generation: 'scope-old' },
  { name: 'blocked', status: 'blocked', eventId: 7, generation: 'scope-a' },
  { name: 'none', status: 'none', eventId: 7, generation: 'scope-a' },
] as const)('keeps final absent for $name', ({ status, eventId, generation }) => {
  const value = view(); value.qualification = { ...value.qualification!, status, eventId, generation }
  wrapper = panel(value)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.get('[data-annual-summary]').text()).toContain('尚无已确认最终结果')
})

it('keeps a returned latest business visible without a final and explains missing source facts in business language', () => {
  const value = view(); value.qualification = null; value.steps = [{ ...value.steps[0]!, status: '已退回待审核', appliedAt: null }]
  value.reasons = ['正式复核缺此次结论年，请补充正式来源。']; value.matter = '复核'; value.year = null
  wrapper = panel(value)
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.text()).toContain('已退回待审核')
  expect(wrapper.text()).toContain('申报时间未记录')
  expect(wrapper.text()).toContain('正式复核缺此次结论年，请补充正式来源。')
  expect(wrapper.text()).not.toContain('2024 年')
})

it('expands interface version and observation provenance and loads the real readOnly compact SourceReader only on demand', async () => {
  const fetch = vi.fn().mockResolvedValue({ source: { id: 22, sequenceNo: 2, nameRaw: '测试企业', rawFields: {}, query: { id: 12, interface: 'business_list', status: 'success', queriedAt: '2026-10-20' } }, correspondences: [] })
  vi.stubGlobal('$fetch', fetch)
  wrapper = panel()
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.get('[data-annual-step="late"] button[aria-expanded]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('SYNTHETIC-LATE')
  expect(wrapper.text()).toContain('业务记录 2 · 版本 3')
  expect(wrapper.text()).toContain('查询 #12 · 原行 2')
  await wrapper.findAll('button').find(button => button.text().includes('读取原行 22'))!.trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/relations/22')
  const reader = wrapper.findComponent({ name: 'SourceReader' })
  expect(reader.props()).toMatchObject({ id: 22, compact: true, readOnly: true, returnTo: '/enterprises/1?tab=review&reviewEventId=7' })
  expect(document.body.textContent).toContain('测试企业')
})

it('emits pagination without relabeling the displayed source page or discarding the existing process', async () => {
  const value = view(); value.total = 26
  wrapper = panel(value)
  await wrapper.get('button[aria-label="下一页"]').trigger('click')
  expect(wrapper.emitted('page')).toEqual([[2]])
  expect(wrapper.text()).toContain('过程来源第 1 页')
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
})

it('returns from the real source reader through the existing event navigation chain without enabling a second decision form', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/enterprises/:id', component: { template: '<div />' } }] })
  await router.push('/enterprises/1?tab=review&reviewEventId=7'); await router.isReady()
  const fetch = vi.fn().mockResolvedValue({ source: { id: 22, sequenceNo: 2, rawFields: {}, query: { id: 12, interface: 'business_list', status: 'success', queriedAt: '2026-10-20' } }, correspondences: [{ id: 40, eventId: 7, relationId: 22, type: 'event_process', role: 'supports_award', status: 'confirmed', requiresRevalidation: false,
    event: { id: 7, eventType: 'award', year: 2024, record: { enterpriseId: 1, titleCode: 'specialized_sme' } } }] })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(AnnualProcessTimeline, { attachTo: document.body, props: { view: view(), back: '/enterprises/1?tab=review&reviewEventId=7' }, global: { plugins: [router], components: { NuxtLink: RouterLink } } })
  await wrapper.get('[data-annual-step="late"] button[aria-expanded]').trigger('click')
  await wrapper.findAll('button').find(button => button.text().includes('读取原行 22'))!.trigger('click'); await flushPromises()
  expect(document.body.querySelector('[data-testid="event-correspondence-decision"]')).toBeNull()
  const link = document.body.querySelector('a')!
  expect(link.getAttribute('href')).toContain('returnTo=')
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  await flushPromises()
  expect(router.currentRoute.value.query.eventId).toBe('7')
  expect(router.currentRoute.value.query.returnTo).toBe('/enterprises/1?tab=review&reviewEventId=7')
  expect(document.body.querySelector('[data-testid="record-source-reader"]')).toBeNull()
  expect(wrapper.emitted('event-navigate')).toEqual([[7]])
  expect(fetch.mock.calls).toHaveLength(1)
})
