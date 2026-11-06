// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import EventArchiveCandidates from '../components/record-correspondence/EventArchiveCandidates.vue'

let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })
const result = (page = 1) => ({ event: { id: 7, evidence: [{ sourceFile: 'synthetic/notice.pdf', attachment: '附件一', listNo: 9, page: 3 }] }, ruleVersion: 'event-archive-212-v1', rows: [{ edge: { relationId: page * 10, eventId: 7 }, evidence: { identity: { officialUsccRaw: '91330211255994457P', rowUsccRaw: '91330211255994457P' }, title: { official: 'specialized_sme', row: 'specialized_sme' }, process: { eventType: 'award', declareKind: 'review' }, temporal: { eventYear: 2022, relationYear: null, eventBatchSeq: 1, relationBatch: null }, source: { queryId: page, relationId: page * 10, sequenceNo: 1, queriedAt: '2026-10-18', status: 'partial' } }, conflicts: ['platform_year_missing'], existingStatus: null }], total: 51, page, pageSize: 50, coverage: { rows: [{ id: 1, interface: 'business_list', outcome: 'partial', status: 'partial', queriedAt: '2026-10-18', relationCount: 1, candidateCount: 1 }], total: 1, page: 1, pageSize: 25 }, interfaces: [{ interface: 'business_list', queried: true, states: [{ status: 'partial', count: 1 }] }, { interface: 'apply_list', queried: false, states: [] }, { interface: 'recognized_list', queried: false, states: [] }] })
const Pagination = { name: 'TablePagination', props: ['page', 'total'], emits: ['update:page', 'update:pageSize'], template: '<div><span>来源页 {{page}}</span><button @click="$emit(\'update:page\', 2)">下一页</button></div>' }
function mountPanel(id = 7) { return mount(EventArchiveCandidates, { props: { eventId: id, back: '/enterprises/1' }, global: { stubs: { EventCorrespondenceDecision: true, TablePagination: Pagination, SourceReader: { name: 'SourceReader', props: ['id', 'presentation'], template: '<div>原始记录 {{id}}</div>' } } } }) }

it('discovers on demand and retains the source page after a failed page request then retries that target', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result(2))
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountPanel(); await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: 7, page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 } })
  expect(wrapper.text()).toContain('平台年份缺失')
  await wrapper.get('[data-testid="candidate-coverage"] button').trigger('click')
  expect(wrapper.text()).toContain('尚无查询归档')
  await wrapper.findAll('button').find(b => b.text() === '下一页')!.trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('候选第 2 页读取失败')
  expect(wrapper.text()).toContain('保留第 1 页')
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).props('edge').relationId).toBe(10)
  await wrapper.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).props('edge').relationId).toBe(20)
  expect(wrapper.text()).not.toContain('读取失败')
})

it('ignores a late previous-event response and clears the previous event facts before a new request', async () => {
  let old!: (value: unknown) => void
  vi.stubGlobal('$fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockResolvedValue({ ...result(), event: { ...result().event, id: 8 } }))
  wrapper = mountPanel(); await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click')
  await wrapper.setProps({ eventId: 8 })
  old(result()); await flushPromises()
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).exists()).toBe(false)
  expect(wrapper.get('[data-testid="candidate-disclosure"] button').attributes('aria-expanded')).toBe('false')
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).props('edge').relationId).toBe(10)
  expect(wrapper.text()).not.toContain('读取失败')
})

it('opens the original row without archive ID input and keeps coverage pagination independent', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result(), coverage: { ...result().coverage, page: 2, rows: [] } })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountPanel(); await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  await wrapper.findAll('button').find(b => b.text() === '查看平台业务详情')!.trigger('click'); await flushPromises()
  expect(document.body.textContent).toContain('原始记录 10')
  await wrapper.get('[data-testid="candidate-coverage"] button').trigger('click')
  await wrapper.findAll('button').filter(b => b.text() === '下一页')[1]!.trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: 7, page: 1, pageSize: 50, queryPage: 2, queryPageSize: 25 } })
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).props('edge').relationId).toBe(10)
})

it('automatically reads only the opened event first page and ignores its late response after switching', async () => {
  let old!: (value: unknown) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockResolvedValue({ ...result(), event: { ...result().event, id: 8 } })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(EventArchiveCandidates, { props: { eventId: 7, back: '/enterprises/1?tab=review', autoLoad: true }, global: { stubs: { EventCorrespondenceDecision: true, TablePagination: Pagination } } })
  await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]![1].body).toEqual({ eventId: 7, page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 })
  expect(wrapper.text()).not.toContain('本页无对应候选')
  await wrapper.setProps({ eventId: 8 }); await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(2)
  old({ ...result(), rows: [], total: 99 }); await flushPromises()
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  expect(wrapper.text()).toContain('来源记录共 51 条')
  expect(wrapper.text()).not.toContain('99 条')
})

it('keeps an empty candidate page distinct from failed partial and complete no record query coverage', async () => {
  const empty = { ...result(), rows: [], total: 0, coverage: { ...result().coverage, rows: ['failed', 'partial', 'no_record', 'no_candidate'].map((outcome, i) => ({ id: i + 1, interface: 'business_list', outcome, failureReason: outcome === 'failed' ? '归档查询失败原因' : null, relationCount: 0, candidateCount: 0 })) } }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(empty))
  wrapper = mountPanel(); await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click'); await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('本页无对应候选')
  await wrapper.get('[data-testid="candidate-coverage"] button').trigger('click')
  expect(wrapper.text()).toContain('查询失败')
  expect(wrapper.text()).toContain('部分结果')
  expect(wrapper.text()).toContain('完整查询无记录')
  expect(wrapper.text()).toContain('有记录但无对应候选')
  expect(wrapper.text()).toContain('归档查询失败原因')
  expect(wrapper.text()).toContain('尚无查询归档')
})


it('separates grouped page items from global source totals and opens every observation in one business reader', async () => {
  const grouped = result()
  const row = { ...grouped.rows[0]!, observationRefs: [
    { relationId: 10, queriedAt: '2026-10-18', queryStatus: 'success' },
    { relationId: 11, queriedAt: '2026-10-19', queryStatus: 'partial' },
  ] }
  const fetch = vi.fn().mockResolvedValue({ ...grouped, rows: [row], total: 105 })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountPanel()
  expect(wrapper.get('[data-testid="candidate-disclosure"] button').attributes('aria-expanded')).toBe('false')
  expect(wrapper.find('[data-testid="discover-event-archives"]').exists()).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('本页可核对项 · 1 项')
  expect(wrapper.text()).toContain('来源记录共 105 条')
  expect(wrapper.findComponent({ name: 'TablePagination' }).props('total')).toBe(105)
  expect(wrapper.findComponent({ name: 'SourceReader' }).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('查询 #')
  await wrapper.findAll('button').find(button => button.text() === '各次来源观察 · 2 条')!.trigger('click')
  expect(wrapper.findAll('[aria-label="各次来源观察"] li')).toHaveLength(2)
  await wrapper.findAll('button').filter(button => button.text() === '查看本次观察')[1]!.trigger('click'); await flushPromises()
  const reader = wrapper.findComponent({ name: 'SourceReader' })
  expect(reader.props()).toMatchObject({ id: 11, presentation: 'business' })
  expect(wrapper.findAllComponents({ name: 'SourceReader' })).toHaveLength(1)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).props('edge').relationId).toBe(10)
})

it('keeps the failed target and retry visible after closing the secondary candidate area', async () => {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('offline')))
  wrapper = mountPanel()
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '下一页')!.trigger('click'); await flushPromises()
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-testid="table-retry"]').isVisible()).toBe(true)
  expect(wrapper.text()).toContain('候选第 2 页读取失败')
  expect(wrapper.text()).toContain('保留第 1 页')
})

it('mounts manual controls only after first opening and retains their draft when the secondary area is collapsed', async () => {
  const fetch = vi.fn().mockResolvedValue(result())
  vi.stubGlobal('$fetch', fetch)
  wrapper = mount(EventArchiveCandidates, { props: { eventId: 7, back: '/enterprises/1', autoLoad: true }, global: { stubs: { TablePagination: Pagination, EventCorrespondenceDecision: { name: 'EventCorrespondenceDecision', data: () => ({ basis: '' }), template: '<input aria-label="核对草稿" v-model="basis" />' } } } })
  await flushPromises()
  expect(wrapper.find('input').exists()).toBe(false)
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  const decision = wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).vm
  await wrapper.get('input').setValue('保留当前人工依据')
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  expect(wrapper.findComponent({ name: 'EventCorrespondenceDecision' }).vm).toBe(decision)
  expect(wrapper.get('input').element.value).toBe('保留当前人工依据')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('compares official and platform fields with explicit missing and difference text while keeping time and multiple candidates separate', async () => {
  const page = result()
  const first = page.rows[0]!
  first.evidence.temporal = { eventYear: 2021, relationYear: 2025, eventBatchSeq: 1, relationBatch: '2025-2', decisionYear: 2024 } as any
  first.evidence.process = { eventType: 'review', declareKind: 'review', appliedAt: '2025-03-01' } as any
  first.conflicts = ['year_mismatch', 'batch_mismatch', 'application_after_decision', 'multiple_candidate_rows']
  const second = structuredClone(first)
  second.edge.relationId = 11
  second.evidence.temporal.relationYear = null
  second.conflicts = ['platform_year_missing', 'multiple_candidate_rows']
  page.rows.push(second)
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(page))
  wrapper = mountPanel()
  await wrapper.get('[data-testid="candidate-disclosure"] button').trigger('click')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  const comparisons = wrapper.findAll('[aria-label="正式公布与平台记录对照"]')
  expect(comparisons).toHaveLength(2)
  const fields = comparisons[0]!.findAll('dl > div')
  expect(fields.find(field => field.text().includes('统一社会信用代码'))!.text()).toContain('一致')
  const year = fields.find(field => field.text().includes('年份'))!.text()
  expect(year).toContain('公布结论年：2024'); expect(year).toContain('办理业务年：2025'); expect(year).toContain('差异')
  expect(comparisons[1]!.text()).toContain('未提供')
  expect(comparisons[0]!.text()).toContain('平台记录 · 申报时间：2025-03-01')
  expect(wrapper.text()).toContain('事项差异'); expect(wrapper.text()).toContain('资料缺失'); expect(wrapper.text()).toContain('时间关系')
  expect(wrapper.text()).toContain('时间先后不代表业务错误')
  expect(wrapper.text().match(/存在多条候选，需逐条核对/g)).toHaveLength(1)
  expect(wrapper.text()).toContain('未确认候选')
})
