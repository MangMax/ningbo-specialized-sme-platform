// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterAll, beforeAll, expect, it } from 'vitest'
import PlatformRecords from '../../../layers/sme-roster/app/components/PlatformRecords.vue'
import type { RosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'

const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })
const date = (value: string | null) => ({ value, raw: value, precision: value ? 'day' as const : 'unknown' as const })
const timeline = { asOf: '2026-11-16', sources: [
  { source: 'publication', collectionStatus: 'not_applicable', collectedAt: null, events: [] },
  { source: 'recognized_list', collectionStatus: 'failed', collectedAt: '2026-11-15', events: [{ key: 'recognized_list:1', platformName: '同码原名', title: 'specialized_sme', matter: 'recognition', matterRaw: null, conclusion: 'passed', statusRaw: null, businessTime: date('2026-03-06'), businessTimeKind: 'recognition', businessYear: 2026, period: { from: date('2026-03-06'), until: date('2029-03-05') }, collectedAt: '2026-11-14' }] },
  { source: 'business_list', collectionStatus: 'not_collected', collectedAt: null, events: [] },
  { source: 'apply_list', collectionStatus: 'success', collectedAt: '2026-11-15', events: [] },
] } as RosterEnterpriseDetail['businessTimeline']

it('keeps four peer sources and retained directory periods without technical controls', async () => {
  const view = mount(PlatformRecords, { props: { timeline }, slots: { publication: '公布文件预览' } })
  expect(view.text()).toContain('公布文件预览')
  expect(view.findAll('[role="tab"]')).toHaveLength(4)
  await view.findAll('[role="tab"]')[1]!.trigger('keydown', { key: 'Enter' })
  expect(view.text()).toContain('同码原名')
  expect(view.text()).toContain('2029-03-05')
  expect(view.text()).toContain('采集失败')
  expect(view.text()).not.toMatch(/绑定|原字段|版本|JSON|查询 #|业务详情|最近采集|资料采集时间/)
  expect(view.text()).not.toContain('2026-11-15')
  view.unmount()
})

it('distinguishes unknown business time from collection time and keeps submission meaning', async () => {
  const event = {
    ...timeline.sources[1]!.events[0]!,
    key: 'apply_list:2',
    matter: 'apply',
    matterRaw: 'apply',
    conclusion: 'processing' as const,
    statusRaw: 'raw_processing_code',
    businessTimeKind: 'submission' as const,
    businessTime: date(null),
    period: { from: date(null), until: date(null) },
  }
  const view = mount(PlatformRecords, { props: { timeline: { ...timeline, sources: timeline.sources.map(s => s.source === 'apply_list' ? { ...s, events: [event] } : s) } } })
  await view.findAll('[role="tab"]')[3]!.trigger('keydown', { key: 'Enter' })
  expect(view.text()).toContain('申报时间：未知')
  expect(view.text()).toContain('结论：办理中')
  expect(view.text()).toContain('业务年度：2026')
  expect(view.text()).toContain('起始未知 至 结束未知')
  expect(view.text()).not.toMatch(/apply|raw_processing_code|2026-11-15|2026-11-14/)
  view.unmount()
})

it('switches every peer source and filters same-enterprise titles without replacing original dates or names', async () => {
  const { Select } = await import('../../../layers/core/app/components/ui/select')
  const known = timeline.sources[1]!.events[0]!
  const other = { ...known, key: 'recognized_list:2', title: 'innovative_sme' as const, platformName: '另一称号原名', businessTime: date('2024-05-08'), period: { from: date('2024-05-08'), until: date('2027-05-07') } }
  const view = mount(PlatformRecords, { props: { timeline: { ...timeline, sources: timeline.sources.map(s => s.source === 'recognized_list' ? { ...s, events: [known, other] } : s) } }, slots: { publication: '公布文件预览' } })
  try {
    await view.findAll('[role="tab"]')[1]!.trigger('keydown', { key: 'Enter' })
    expect(view.findAll('[data-testid="business-event"]')).toHaveLength(2)
    view.findComponent(Select).vm.$emit('update:modelValue', 'specialized_sme')
    await view.vm.$nextTick()
    expect(view.findAll('[data-testid="business-event"]')).toHaveLength(1)
    expect(view.text()).toContain('同码原名')
    expect(view.text()).toContain('2026-03-06')
    expect(view.text()).toContain('2029-03-05')
    expect(view.text()).not.toContain('另一称号原名')
    for (const index of [2, 3]) {
      await view.findAll('[role="tab"]')[index]!.trigger('keydown', { key: 'Enter' })
      expect(view.text()).toContain('暂无已知业务事件')
    }
    await view.findAll('[role="tab"]')[2]!.trigger('keydown', { key: 'Enter' })
    expect(view.text()).toContain('尚未采集')
    await view.findAll('[role="tab"]')[0]!.trigger('keydown', { key: 'Enter' })
    expect(view.text()).toContain('公布文件预览')
  } finally { view.unmount() }
})

it('uses the publication slot instead of rendering duplicate generic publication cards', () => {
  const event = { ...timeline.sources[1]!.events[0]!, key: 'publication:1', platformName: null }
  const input = { ...timeline, sources: timeline.sources.map(s => s.source === 'publication' ? { ...s, events: [event] } : s) }
  const view = mount(PlatformRecords, { props: { timeline: input }, slots: { publication: '<p>正式认定及出处</p>' } })
  try {
    expect(view.text()).toContain('正式认定及出处')
    expect(view.findAll('[data-testid="business-event"]')).toHaveLength(0)
  } finally { view.unmount() }
  const fallback = mount(PlatformRecords, { props: { timeline: input } })
  try { expect(fallback.findAll('[data-testid="business-event"]')).toHaveLength(1) }
  finally { fallback.unmount() }
})
