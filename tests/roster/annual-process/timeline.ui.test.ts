// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import AnnualProcessReview from '../../../components/record-correspondence/AnnualProcessReview.vue'
import AnnualProcessTimeline from '../../../components/record-correspondence/AnnualProcessTimeline.vue'
import type { AnnualTimelineView } from '../../../lib/roster/annual-process-presentation'

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
  expect(steps.every(step => step.findAll('[data-timeline-node][aria-hidden="true"]').length === 1)).toBe(true)
  expect(steps[0]!.find('[data-timeline-connector][aria-hidden="true"]').exists()).toBe(true)
  expect(steps[1]!.find('[data-timeline-connector]').exists()).toBe(false)
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
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(1)
  expect(wrapper.findAll('[data-timeline-node]')).toHaveLength(1)
  expect(wrapper.find('[data-timeline-connector]').exists()).toBe(false)
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
  expect(wrapper.text()).not.toContain('SYNTHETIC-LATE')
  await wrapper.findAll('button').find(button => button.text() === '技术定位与本次观察决定')!.trigger('click')
  expect(wrapper.text()).toContain('SYNTHETIC-LATE')
  expect(wrapper.text()).toContain('业务记录 2 · 版本 3')
  expect(wrapper.text()).toContain('查询 #12 · 原行 2')
  await wrapper.findAll('button').find(button => button.text() === '查看平台业务详情')!.trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/relations/22')
  const reader = wrapper.findComponent({ name: 'SourceReader' })
  expect(reader.props()).toMatchObject({ id: 22, presentation: 'business', compact: true, readOnly: true, returnTo: '/enterprises/1?tab=review&reviewEventId=7' })
  expect(document.body.textContent).toContain('测试企业')
})

it('emits continuous load intent without page controls or discarding the existing process', async () => {
  const value = view(); value.total = 26
  wrapper = panel(value)
  await wrapper.setProps({ hasMore: true })
  await wrapper.findAll('button').find(button => button.text() === '加载更多过程')!.trigger('click')
  expect(wrapper.emitted('load-more')).toEqual([[]])
  expect(wrapper.text()).not.toMatch(/每页|过程来源第/)
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
  await wrapper.findAll('button').find(button => button.text() === '查看平台业务详情')!.trigger('click'); await flushPromises()
  expect(document.body.querySelector('[data-testid="event-correspondence-decision"]')).toBeNull()
  const related = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '相关认定与复核记录（只读）')!
  related.click(); await flushPromises()
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


it('keeps each observation decision behind its own technical disclosure and opens only the selected business reader', async () => {
  const value = view()
  value.steps[0]!.sources[0]!.observations.push({ relationId: 23, queryId: 13, row: 4, queriedAt: '2026-10-21', decision: '已否定对应', revision: 8 })
  wrapper = mount(AnnualProcessTimeline, { props: { view: value, back: '/return' }, global: { stubs: { SourceReader: { name: 'SourceReader', props: { id: Number, presentation: String, readOnly: Boolean }, template: '<div>选中业务</div>' } } } })
  expect(wrapper.findComponent({ name: 'SourceReader' }).exists()).toBe(false)
  expect(wrapper.text()).not.toMatch(/SYNTHETIC-LATE|版本 3|查询 #12|已否定对应/)
  await wrapper.get('[data-annual-step="late"] button[aria-expanded]').trigger('click')
  expect(wrapper.text()).toContain('2026-10-20')
  expect(wrapper.text()).toContain('2026-10-21')
  expect(wrapper.text()).not.toContain('查询 #')
  const disclosures = wrapper.findAll('button').filter(button => button.text() === '技术定位与本次观察决定')
  await disclosures[1]!.trigger('click')
  expect(wrapper.text()).toContain('查询 #13 · 原行 4')
  expect(wrapper.text()).toContain('本观察决定：已否定对应 · 修订 8')
  expect(wrapper.text()).not.toContain('查询 #12')
  await wrapper.findAll('button').filter(button => button.text() === '查看平台业务详情')[1]!.trigger('click'); await flushPromises()
  expect(wrapper.findAllComponents({ name: 'SourceReader' })).toHaveLength(1)
  expect(wrapper.findComponent({ name: 'SourceReader' }).props()).toMatchObject({ id: 23, presentation: 'business', readOnly: true })
})

it.each(['待审核', '已退回待审核'])('keeps the actual nonfinal status %s visible without turning it into an artificial manual error', status => {
  const value = view(); value.qualification = null; value.latestStatus = status
  value.steps = [{ ...value.steps[0]!, status, reasons: [] }]
  wrapper = panel(value)
  expect(wrapper.text()).toContain(status)
  expect(wrapper.find('[data-final-result]').exists()).toBe(false)
  expect(wrapper.text()).not.toMatch(/必须人工|人工错误|核对失败/)
  expect(wrapper.find('[role="table"]').exists()).toBe(false)
  expect(wrapper.find('table').exists()).toBe(false)
})

it('retains visible process facts but removes the official final on read failure and emits only the existing retry action', async () => {
  wrapper = mount(AnnualProcessReview, { props: { view: view(), back: '/return', phase: 'synced', readFailed: true, auditReadback: [{ id: 99, revision: 3, status: 'confirmed' }] } })
  expect(wrapper.findAll('[data-annual-step]')).toHaveLength(2)
  expect(wrapper.text()).toContain('终审通过')
  expect(wrapper.find('[data-final-result]').exists()).toBe(false)
  expect(wrapper.text()).toContain('保留已加载的年度过程及其来源')
  expect(wrapper.text()).not.toContain('对应 #99')
  await wrapper.get('[data-testid="table-retry"]').trigger('click')
  expect(wrapper.emitted('retry-read')).toEqual([[]])
  expect(wrapper.emitted('retry-submit')).toBeUndefined()
  await wrapper.setProps({ readFailed: false })
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})

it('shows a short successful readback while keeping active progress and current source warnings visible', async () => {
  wrapper = mount(AnnualProcessReview, { props: { view: view(), back: '/return', phase: 'synced', progress: '已处理 1/1 个事件', businessReasons: ['来源需要重新核验'] } })
  expect(wrapper.text()).toContain('已读回当前年度过程、对应与审计。')
  expect(wrapper.text()).not.toContain('已处理 1/1 个事件')
  expect(wrapper.text()).toContain('来源需要重新核验')
  await wrapper.setProps({ phase: 'running', progress: '正在处理当前事件' })
  expect(wrapper.text()).toContain('正在处理当前事件')
  expect(wrapper.find('[data-final-result]').exists()).toBe(false)
})
