// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import EventArchiveCandidates from '../components/record-correspondence/EventArchiveCandidates.vue'

let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })
const result = (page = 1) => ({ event: { id: 7, evidence: [{ sourceFile: 'synthetic/notice.pdf', attachment: '附件一', listNo: 9, page: 3 }] }, ruleVersion: 'event-archive-212-v1', rows: [{ edge: { relationId: page * 10, eventId: 7 }, evidence: { identity: { officialUsccRaw: '91330211255994457P', rowUsccRaw: '91330211255994457P' }, title: { official: 'specialized_sme', row: 'specialized_sme' }, process: { eventType: 'award', declareKind: 'review' }, temporal: { eventYear: 2022, relationYear: null, eventBatchSeq: 1, relationBatch: null }, source: { queryId: page, relationId: page * 10, sequenceNo: 1, queriedAt: '2026-10-18', status: 'partial' } }, conflicts: ['platform_year_missing'], existingStatus: null }], total: 51, page, pageSize: 50, coverage: { rows: [{ id: 1, interface: 'business_list', outcome: 'partial', status: 'partial', queriedAt: '2026-10-18', relationCount: 1, candidateCount: 1 }], total: 1, page: 1, pageSize: 25 }, interfaces: [{ interface: 'business_list', queried: true, states: [{ status: 'partial', count: 1 }] }, { interface: 'apply_list', queried: false, states: [] }, { interface: 'recognized_list', queried: false, states: [] }] })
const Pagination = { props: ['page', 'total'], emits: ['update:page', 'update:pageSize'], template: '<div><span>来源页 {{page}}</span><button @click="$emit(\'update:page\', 2)">下一页</button></div>' }
function mountPanel(id = 7) { return mount(EventArchiveCandidates, { props: { eventId: id, back: '/enterprises/1' }, global: { stubs: { EventCorrespondenceDecision: true, TablePagination: Pagination, SourceReader: { props: ['id'], template: '<div>原始记录 {{id}}</div>' } } } }) }

it('discovers on demand and retains the source page after a failed page request then retries that target', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result(2))
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountPanel()
  expect(fetch).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: 7, page: 1, pageSize: 50, queryPage: 1, queryPageSize: 25 } })
  expect(wrapper.text()).toContain('平台年份缺失')
  expect(wrapper.text()).toContain('尚无查询归档')
  await wrapper.findAll('button').find(b => b.text() === '下一页')!.trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('候选第 2 页读取失败')
  expect(wrapper.text()).toContain('保留第 1 页')
  expect(wrapper.text()).toContain('查询 #1')
  await wrapper.get('[data-testid="table-retry"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('查询 #2')
  expect(wrapper.text()).not.toContain('读取失败')
})

it('ignores a late previous-event response and clears the previous event facts before a new request', async () => {
  let old!: (value: unknown) => void
  vi.stubGlobal('$fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockResolvedValue({ ...result(), event: { ...result().event, id: 8 } }))
  wrapper = mountPanel()
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click')
  await wrapper.setProps({ eventId: 8 })
  old(result()); await flushPromises()
  expect(wrapper.text()).not.toContain('查询 #1')
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('查询 #1')
  expect(wrapper.text()).not.toContain('读取失败')
})

it('opens the original row without archive ID input and keeps coverage pagination independent', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result(), coverage: { ...result().coverage, page: 2, rows: [] } })
  vi.stubGlobal('$fetch', fetch)
  wrapper = mountPanel()
  await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  await wrapper.findAll('button').find(b => b.text() === '查看平台原行与查询来源')!.trigger('click'); await flushPromises()
  expect(document.body.textContent).toContain('原始记录 10')
  await wrapper.findAll('button').filter(b => b.text() === '下一页')[1]!.trigger('click'); await flushPromises()
  expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences/discover', { method: 'POST', body: { eventId: 7, page: 1, pageSize: 50, queryPage: 2, queryPageSize: 25 } })
  expect(wrapper.text()).toContain('查询 #1')
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
  expect(wrapper.text()).toContain('平台候选 · 51 条')
  expect(wrapper.text()).not.toContain('99 条')
})

it('keeps an empty candidate page distinct from failed partial and complete no record query coverage', async () => {
  const empty = { ...result(), rows: [], total: 0, coverage: { ...result().coverage, rows: ['failed', 'partial', 'no_record', 'no_candidate'].map((outcome, i) => ({ id: i + 1, interface: 'business_list', outcome, failureReason: outcome === 'failed' ? '归档查询失败原因' : null, relationCount: 0, candidateCount: 0 })) } }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(empty))
  wrapper = mountPanel(); await wrapper.get('[data-testid="discover-event-archives"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('本页无对应候选')
  expect(wrapper.text()).toContain('查询失败')
  expect(wrapper.text()).toContain('部分结果')
  expect(wrapper.text()).toContain('完整查询无记录')
  expect(wrapper.text()).toContain('有记录但无对应候选')
  expect(wrapper.text()).toContain('归档查询失败原因')
  expect(wrapper.text()).toContain('尚无查询归档')
})
