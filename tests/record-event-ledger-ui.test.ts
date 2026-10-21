// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import RecordEventRow from '../components/record-correspondence/RecordEventRow.vue'
import RecordEventSource from '../components/record-correspondence/RecordEventSource.vue'
import { DialogContent } from '../components/ui/dialog'
import type { CorrespondenceDetail } from '../lib/roster/correspondence-view'
import { groupEventEdges } from '../lib/roster/record-ledger'

const event = { id: 9, recordId: 2, type: 'review', year: 2021, seq: 1, decidedYear: 2024, reviewOutcome: 'passed', titleCode: 'specialized_sme', source: 'jxj', district: null }
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

it('keeps unconfirmed and invalidated export matches out of confirmed current references', () => {
  const groups = groupEventEdges([
    { id: 1, type: 'event_export_context' as const, status: 'confirmed' as const, requiresRevalidation: false },
    { id: 2, type: 'event_export_context' as const, status: 'candidate' as const, requiresRevalidation: false },
    { id: 3, type: 'event_export_context' as const, status: 'confirmed' as const, requiresRevalidation: true },
    { id: 4, type: 'event_export_context' as const, status: 'unlinked' as const, requiresRevalidation: false },
  ])
  expect(groups.sources).toEqual([])
  expect(groups.currentContext.map(edge => edge.id)).toEqual([1])
  expect(groups.candidates.map(edge => edge.id)).toEqual([2])
  expect(groups.revalidation.map(edge => edge.id)).toEqual([3])
  expect(groups.history.map(edge => edge.id)).toEqual([4])
})

it('uses the review conclusion year as the ledger year while retaining its original award year', () => {
  const wrapper = mount(RecordEventRow, { props: { event, evidence: [], edges: [], back: '/enterprises/42', open: false }, global: { stubs: { EventChip: true, TitleBadge: true, SourceChip: true, RecordEventSource: true } } })
  mounted.push(wrapper)
  expect(wrapper.get('.tabular-nums').text()).toBe('2024')
  expect(wrapper.text()).toContain('原认定 2021 年 · 复核结论 2024 年')
})

it('closes the source dialog before returning to the same event and preserves the comparison return path', async () => {
  const returnTo = '/comparison?mode=record&queryIds=7&officialSourceDocumentIds=3'
  const edge = { id: 1, type: 'event_process', role: 'supports_review', status: 'confirmed', requiresRevalidation: false, relationId: 30,
    relation: { id: 30, sequenceNo: 4, nameRaw: '恒川制造', status: '终审通过', query: { id: 7, interface: 'apply_list', status: 'success', queriedAt: '2024-12-01' } },
  } as unknown as CorrespondenceDetail
  const wrapper = mount(RecordEventSource, { props: { event, evidence: [], edges: [edge], back: `/enterprises/42?eventId=9&returnTo=${encodeURIComponent(returnTo)}`, returnTo }, global: { stubs: {
    Dialog: { template: '<div><slot /></div>' },
    DialogContent: { emits: ['closeAutoFocus'], template: '<div><slot /></div>' },
    DialogTitle: { template: '<h3><slot /></h3>' },
    DialogDescription: { template: '<p><slot /></p>' },
    SourceReader: { name: 'SourceReader', props: ['returnTo'], emits: ['event-navigate'], template: '<button data-testid="return-event" @click="$emit(\'event-navigate\', 9)">跳到该记录</button>' },
  } } })
  mounted.push(wrapper)
  await wrapper.findAll('button').find(button => button.text() === '查看原始记录')!.trigger('click')
  expect(wrapper.findComponent({ name: 'SourceReader' }).props('returnTo')).toBe(returnTo)
  await wrapper.get('[data-testid="return-event"]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="return-event"]').exists()).toBe(false)
  expect(wrapper.emitted('event-navigate')).toBeUndefined()
  const close = new Event('closeAutoFocus', { cancelable: true })
  wrapper.findComponent(DialogContent).vm.$emit('closeAutoFocus', close)
  expect(close.defaultPrevented).toBe(true)
  expect(wrapper.emitted('event-navigate')).toEqual([[9]])
})

it('keeps formal evidence visible and offers retry while expanded platform points fail', async () => {
  const wrapper = mount(RecordEventSource, { props: {
    event, evidence: [{ sourceFile: 'jxj/announcement/synthetic.pdf', attachment: null, listNo: 2, page: 8 }],
    edges: [], edgesReady: false, edgesError: true, back: '/enterprises/42',
  }, global: { stubs: { NuxtLink: { props: ['to'], template: '<a><slot /></a>' }, SourceReader: true } } })
  mounted.push(wrapper)
  expect(wrapper.text()).toContain('第 8 页')
  expect(wrapper.text()).toContain('不能据此判断没有来源')
  expect(wrapper.text()).not.toContain('暂无与这条记录匹配')
  await wrapper.findAll('button').find(button => button.text() === '重试读取')!.trigger('click')
  expect(wrapper.emitted('retry-detail')).toEqual([[]])
})
