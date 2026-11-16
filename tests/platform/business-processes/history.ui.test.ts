// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import PlatformRecords from '../../../components/PlatformRecords.vue'
import type { RosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'

const date = (value: string | null) => ({ value, raw: value, precision: value ? 'day' as const : 'unknown' as const })
const timeline = { asOf: '2026-11-16', sources: [
  { source: 'publication', collectionStatus: 'not_applicable', collectedAt: null, events: [] },
  { source: 'recognized_list', collectionStatus: 'failed', collectedAt: '2026-11-15', events: [{ key: 'recognized_list:1', platformName: '同码原名', title: 'specialized_sme', matter: 'recognition', matterRaw: null, conclusion: 'passed', statusRaw: null, businessTime: date('2026-03-06'), businessTimeKind: 'recognition', businessYear: 2026, period: { from: date('2026-03-06'), until: date('2029-03-05') }, collectedAt: '2026-11-14', cycleKey: null }] },
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
  expect(view.text()).not.toMatch(/绑定|原字段|版本|JSON|查询 #/)
  view.unmount()
})

it('distinguishes unknown business time from collection time and keeps submission meaning', async () => {
  const event = { ...timeline.sources[1]!.events[0]!, key: 'apply_list:2', businessTimeKind: 'submission' as const, businessTime: date(null), period: { from: date(null), until: date(null) } }
  const view = mount(PlatformRecords, { props: { timeline: { ...timeline, sources: timeline.sources.map(s => s.source === 'apply_list' ? { ...s, events: [event] } : s) } } })
  await view.findAll('[role="tab"]')[3]!.trigger('keydown', { key: 'Enter' })
  expect(view.text()).toContain('申报时间：未知')
  expect(view.text()).toContain('起始未知 至 结束未知')
  expect(view.text()).not.toContain('申报时间：2026-11-15')
  view.unmount()
})
