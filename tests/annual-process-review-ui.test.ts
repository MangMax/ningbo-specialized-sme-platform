// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import AnnualProcessReview from '../components/record-correspondence/AnnualProcessReview.vue'
import type { AnnualTimelineView } from '../lib/roster/annual-process-presentation'

let wrapper: ReturnType<typeof mount>
afterEach(() => wrapper?.unmount())

it('shows readonly and pending qualification honestly without offering automatic confirmation controls', () => {
  wrapper = mount(AnnualProcessReview, { props: { back: '/enterprises/1', view: null, phase: 'read-only' } })
  expect(wrapper.text()).toContain('当前只读')
  expect(wrapper.text()).toContain('未开启或未能确认')
  expect(wrapper.text()).not.toContain('已完成')
  expect(wrapper.findAll('button').map(button => button.text())).not.toContain('确认')
})

it.each([
  { phase: 'submitting', text: '正在提交本事件年度核对' },
  { phase: 'running', text: '正在核对本事件年度过程' },
  { phase: 'syncing', text: '正在读回年度过程、对应与审计' },
  { phase: 'synced', text: '已读回当前年度过程、对应与审计' },
  { phase: 'failed', text: '年度核对失败' },
  { phase: 'cancelled', text: '年度核对已取消' },
  { phase: 'blocked', text: '来源已变化' },
] as const)('renders the $phase lifecycle without claiming success early', ({ phase, text }) => {
  wrapper = mount(AnnualProcessReview, { props: { back: '/enterprises/1', view: null, phase } })
  expect(wrapper.text()).toContain(text)
  if (phase !== 'synced') expect(wrapper.text()).not.toContain('已读回当前年度过程、对应与审计')
})

it('offers same-request retry for an unknown submission and readback-only retry after accepted submission', async () => {
  wrapper = mount(AnnualProcessReview, { props: { back: '/enterprises/1', view: null, phase: 'unknown' } })
  expect(wrapper.text()).toContain('提交结果尚未确认')
  expect(wrapper.text()).toContain('保留同一请求')
  await wrapper.findAll('button').find(button => button.text() === '重试同一请求')!.trigger('click')
  expect(wrapper.emitted('retry-submit')).toEqual([[]])
  await wrapper.setProps({ phase: 'sync-failed' })
  expect(wrapper.text()).toContain('已提交，但同步读回失败')
  expect(wrapper.text()).toContain('不会重复提交')
  expect(wrapper.findAll('button').map(button => button.text())).not.toContain('重试同一请求')
  await wrapper.findAll('button').find(button => button.text() === '重试读回')!.trigger('click')
  expect(wrapper.emitted('retry-readback')).toEqual([[]])
})

it('keeps failed target page and server supplied business reasons while exposing only allowed task actions', async () => {
  wrapper = mount(AnnualProcessReview, { props: { back: '/enterprises/1', view: null, phase: 'failed', readFailed: true, targetPage: 2, canRetry: true, canCancel: false, businessReasons: ['正式复核缺此次结论年，请补充正式来源。'] } })
  expect(wrapper.text()).toContain('年度过程第 2 页读取失败')
  expect(wrapper.text()).toContain('正式复核缺此次结论年，请补充正式来源。')
  expect(wrapper.findAll('button').map(button => button.text())).not.toContain('取消任务')
  await wrapper.findAll('button').find(button => button.text() === '重试任务')!.trigger('click')
  expect(wrapper.emitted('retry-task')).toEqual([[]])
  await wrapper.setProps({ phase: 'running', canCancel: true, canRetry: false })
  await wrapper.findAll('button').find(button => button.text() === '取消任务')!.trigger('click')
  expect(wrapper.emitted('cancel')).toEqual([[]])
})

it('keeps process facts but withholds final success while accepted work is still synchronizing or readback failed', async () => {
  const view: AnnualTimelineView = { eventId: 7, generation: 'current', title: '专精特新中小企业', matter: '认定', year: 2024,
    latestStepId: 'latest', qualification: { eventId: 7, generation: 'current', stepId: 'latest', status: 'confirmed', reasons: [] },
    steps: [{ id: 'latest', appliedAt: '2024-12-01', status: '终审通过', observedAt: null, businessKey: null, reasons: [], sources: [] }],
    reasons: [], coverage: [], page: 1, pageSize: 25, total: 26 }
  wrapper = mount(AnnualProcessReview, { props: { back: '/enterprises/1', view, phase: 'syncing', readFailed: true, targetPage: 2 } })
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  expect(wrapper.text()).toContain('终审通过')
  expect(wrapper.text()).toContain('保留第 1 页年度过程及其来源')
  await wrapper.setProps({ phase: 'sync-failed' })
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(0)
  await wrapper.setProps({ phase: 'synced', readFailed: false })
  expect(wrapper.findAll('[data-final-result]')).toHaveLength(1)
})
