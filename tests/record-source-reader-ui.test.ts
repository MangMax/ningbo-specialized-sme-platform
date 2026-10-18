// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SourceReader from '../components/record-correspondence/SourceReader.vue'

const event = { id: 9, recordId: 2, eventType: 'award', year: 2022, batchSeq: 1, decidedYear: 2022, reviewOutcome: null,
  record: { id: 2, enterpriseId: 42, titleCode: 'specialized_sme', source: 'jxj', usccRaw: '913300000000000004' }, evidence: [], correspondences: [] }
const query = { id: 20, interface: 'apply_list', queryKey: '913300000000000004', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2024-01-02T00:00:00Z', status: 'partial', failureReason: null, relationCount: 1, collectionEvidence: null }
const relation = { id: 30, queryId: 20, sequenceNo: 4, relationKey: 'SQ-2024-1', enterpriseId: 42, usccRaw: '913300000000000004', nameRaw: '合成企业', province: '浙江', status: '退回', batch: '2024-1', declareKind: 'update', appliedAt: '2024-01-01', awardBatchLabel: null, year: 2024, sourceRdjb: '2', sourcePage: 3, rawFields: { cszt: '退回' }, query, correspondences: [] }
const edge = (id: number, type: string, status: string) => ({ id, type, role: type === 'later_process' ? 'followup_update' : 'supports_award', status, revision: 1, requiresRevalidation: false, eventId: type === 'later_process' ? null : 9, predecessorEventId: type === 'later_process' ? 9 : null, relationId: 30, exportRowId: null, enterpriseId: 42, titleCode: 'specialized_sme', ruleId: 'fixture', ruleVersion: '1', createdAt: '2024-01-02', decidedAt: status === 'confirmed' ? '2024-01-02' : null, endedAt: null, event: type === 'later_process' ? null : event, predecessorEvent: type === 'later_process' ? event : null, relation, exportRow: null })

const mounted: ReturnType<typeof mount>[] = []
const stubs = { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' }, PlatformQueryProvenance: true }
function render(kind: 'event' | 'relation', id: number) {
  const wrapper = mount(SourceReader, { props: { kind, id, returnTo: '/comparison?mode=record' }, global: { stubs } })
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

describe('record source reader public interaction', () => {
  it('shows only sources matched to this event and marks candidates without exposing internal audit copy', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => ({ source: event, correspondences: [edge(1, 'event_process', 'confirmed'), edge(2, 'later_process', 'candidate'), edge(3, 'event_recognized', 'candidate')] })))
    const wrapper = render('event', 9)
    await flushPromises()
    expect(wrapper.text()).toContain('已确认')
    expect(wrapper.text()).toContain('待确认')
    expect(wrapper.find('[data-correspondence-id="1"]').exists()).toBe(true)
    expect(wrapper.find('[data-correspondence-id="3"]').exists()).toBe(true)
    expect(wrapper.find('[data-correspondence-id="2"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('后续流程')
    expect(wrapper.text()).not.toContain('规则 fixture')
    expect(wrapper.text()).not.toContain('决定于')
  })

  it('keeps a successful source on failure and retries the same original row', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ source: relation, correspondences: [edge(1, 'event_process', 'confirmed')] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ source: relation, correspondences: [] })
    vi.stubGlobal('$fetch', fetch)
    const wrapper = render('relation', 30)
    await flushPromises()
    expect(wrapper.get('[aria-label="来源行反向对应"]').text()).toContain('已确认')
    await wrapper.setProps({ id: 31 })
    await flushPromises()
    expect(wrapper.text()).toContain('未能读取来源行出处')
    expect(wrapper.text()).toContain('合成企业')
    expect(wrapper.text()).toContain('上次成功')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences/relations/31')
    expect(wrapper.get('[aria-label="来源行反向对应"]').text()).toContain('尚无登记的对应关系')
  })

  it.each([
    { name: 'direct review event', type: 'event_process', year: 2021, decidedYear: 2024, expected: '原认定 2021 年 · 复核结论 2024 年 · 复核不通过' },
    { name: 'predecessor review with unknown years', type: 'later_process', year: null, decidedYear: null, expected: '原认定 年份待核 · 复核结论年份待核 · 复核不通过' },
  ])('uses explicit business years in the link for $name', async ({ type, year, decidedYear, expected }) => {
    const review = { ...event, eventType: 'review', year, decidedYear, reviewOutcome: 'failed' }
    const correspondence = { ...edge(1, type, 'confirmed'), event: type === 'later_process' ? null : review, predecessorEvent: type === 'later_process' ? review : null }
    vi.stubGlobal('$fetch', vi.fn(async () => ({ source: relation, correspondences: [correspondence] })))
    const wrapper = render('relation', 30)
    await flushPromises()
    const link = wrapper.get('a')
    expect(link.text()).toContain(expected)
    expect(link.text()).toContain('事件 #9')
    expect(link.text()).not.toContain('复核 2021')
    expect(link.text()).not.toContain('failed')
  })

  it('labels a review by its original award year and later conclusion year', async () => {
    const review = { ...event, eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' }
    vi.stubGlobal('$fetch', vi.fn(async () => ({ source: review, correspondences: [] })))
    const wrapper = render('event', 9)
    await flushPromises()
    expect(wrapper.text()).toContain('原认定 2021 年 · 复核结论 2024 年 · 复核不通过')
    expect(wrapper.text()).not.toContain('failed')
  })
})
