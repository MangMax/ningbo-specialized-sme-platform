// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ComparisonEvidence from '../components/record-correspondence/ComparisonEvidence.vue'
import ComparisonEventRow from '../components/record-correspondence/ComparisonEventRow.vue'
import type { RecordComparisonResult } from '../lib/roster/record-comparison-view'

const row = {
  event: { id: 9, recordId: 2, eventType: 'award', year: 2024, batchSeq: 1, decidedYear: 2024, reviewOutcome: null },
  record: { id: 2, enterpriseId: 42, titleCode: 'specialized_sme', source: 'jxj', usccRaw: '913300000000000004', nameRaw: '合成企业' },
  evidence: [{ id: 4, sourceFile: 'jxj/announcement/a.pdf', attachment: '附件一', listNo: 8, page: 3, inSelectedSource: true }],
  classification: 'historical_aligned', reasons: [], correspondences: [], platformRows: [], laterProcesses: [],
} as unknown as RecordComparisonResult['rows'][number]
const relation = { id: 30, queryId: 7, interface: 'recognized_list', sequenceNo: 1, nameRaw: '合成企业', status: '在册', queriedAt: '2025-01-01', sourcePage: 2 }
const exportRow = { id: 8, batchId: 6, sourceRowNo: 12, nameRaw: '合成企业', titleCode: 'specialized_sme', collectedOn: '2025-02-01' }
const result = { rows: [row], total: 1, page: 1, pageSize: 25,
  counts: { distinctEvents: 1, distinctPlatformRows: 1, distinctEnterpriseTitles: 1, laterProcessRows: 0, historical_aligned: 1, historical_conflict: 0, official_without_correspondence: 0, unresolved: 0, platformWithoutOfficialRows: 0, unresolvedPlatformRows: 1, recognizedRows: 1, exportRows: 1, observedRecognizedExportPairs: 1 },
  coverage: [{ queryId: 7, interface: 'recognized_list', status: 'partial', queriedAt: '2025-01-01', titleCoverage: [{ titleCode: 'specialized_sme' }], effectiveConditions: { combination: 'and', uscc: '913300000000000004' }, completeness: 'partial', fullRange: false, reasons: ['incomplete_or_continuation'] }],
  officialCoverage: { qualification: 'unknown', reasons: ['official_source_completeness_not_persisted'] },
  currentSourceConsistency: { qualification: 'not_comparable', reasons: ['version_equivalence_unknown'], recognizedObservations: [{ recognized: relation, exportRows: [exportRow], observation: 'same_uscc_title_observed', qualification: 'not_comparable' }], exportObservations: [{ exportRow, recognizedRelationIds: [30], qualification: 'not_comparable' }] },
  platformWithoutOfficial: { rows: [{ relation, qualification: 'unresolved', reasons: ['official_source_completeness_not_persisted'] }], total: 1 },
  historicalDecisionUnavailable: [{ id: 99, eventId: 9, relationId: 30, reason: 'post_cutoff_decision_state_unavailable' }],
  laterProcessPlatformRows: [{ relation: { ...relation, id: 44, status: '退回' }, correspondences: [{ id: 5, role: 'followup_update', status: 'confirmed' }] }],
} as unknown as RecordComparisonResult
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })

it('keeps positive same-subject rows visible while qualification stays unknown', async () => {
  const wrapper = mount(ComparisonEvidence, { props: { result, returnTo: '/comparison?mode=record' }, global: { stubs: { SourceReader: true } } })
  mounted.push(wrapper)
  await wrapper.get('[data-testid="record-current-consistency"] summary').trigger('click')
  expect(wrapper.get('[data-testid="record-current-consistency"]').text()).toContain('暂不可比较')
  expect(wrapper.get('[data-testid="record-current-consistency"]').text()).toContain('源行 12')
  expect(wrapper.get('[data-testid="record-comparison-coverage"]').text()).toContain('部分')
  expect(wrapper.get('[data-testid="record-platform-unlinked"]').text()).toContain('正式来源覆盖待核')
  expect(wrapper.get('[data-testid="record-independent-later"]').text()).toContain('退回')
  expect(wrapper.get('[data-testid="record-independent-later"]').text()).toContain('查看原行与反向对应')
  expect(wrapper.text()).toContain('对应 #99 · 事件 #9 · 接口原行 #30')
  expect(wrapper.text()).not.toContain('post_cutoff_decision_state_unavailable')
})

it('links the actual stored PDF page and saves comparison scroll before detail navigation', async () => {
  sessionStorage.clear()
  history.replaceState(null, '', '/comparison?mode=record&queryIds=7')
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 380 })
  const wrapper = mount(ComparisonEventRow, { props: { row, returnTo: '/comparison?mode=record&queryIds=7' }, global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' }, SourceReader: true } } })
  mounted.push(wrapper)
  const pageLink = wrapper.findAll('a').find(link => link.text() === '第 3 页')
  expect(pageLink).toBeDefined()
  const target = pageLink!.attributes('href')!
  expect(target).toContain('/preview')
  expect(decodeURIComponent(target)).toContain('back=/comparison?mode=record&queryIds=7')
  expect(target).toContain('page=3')
  const detailLink = wrapper.findAll('a').find(link => link.text() === '合成企业')
  expect(detailLink).toBeDefined()
  await detailLink!.trigger('click', { button: 0 })
  expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain('"scrollY":380')
  expect(sessionStorage.getItem('roster:evidence-preview-return')).toContain('/comparison?mode=record&queryIds=7')
})

it('shows review business years and readable count grains without internal enum or ID vocabulary', () => {
  const review = { ...row, event: { ...row.event, eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' } } as RecordComparisonResult['rows'][number]
  const item = mount(ComparisonEventRow, { props: { row: review, returnTo: '/comparison?mode=record' }, global: { stubs: { NuxtLink: true, SourceReader: true } } })
  mounted.push(item)
  expect(item.text()).toContain('原认定 2021 年 · 复核结论 2024 年 · 复核不通过')
  expect(item.text()).not.toContain('failed')
  const summary = mount(ComparisonEvidence, { props: { result, returnTo: '/comparison?mode=record' }, global: { stubs: { SourceReader: true } } })
  mounted.push(summary)
  expect(summary.get('[aria-label="记录级计数"]').text()).toContain('正式事件（按事件去重）')
  expect(summary.get('[aria-label="记录级计数"]').text()).toContain('接口原行（按原行去重）')
  expect(summary.get('[aria-label="记录级计数"]').text()).not.toContain('ID')
})


const sourceDialogStubs = {
  NuxtLink: true,
  Dialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
  DialogContent: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<h3><slot /></h3>' },
  DialogDescription: { template: '<p><slot /></p>' },
}
const repeatedRelations = [
  { ...relation, id: 101, queryId: 7, sequenceNo: 1 },
  { ...relation, id: 102, queryId: 7, sequenceNo: 2 },
  { ...relation, id: 103, queryId: 8, sequenceNo: 1 },
  { ...relation, id: 104, queryId: 8, sequenceNo: 2 },
  { ...relation, id: 105, queryId: 9, sequenceNo: 1 },
  { ...relation, id: 106, queryId: 9, sequenceNo: 2 },
]

it('keeps six identical-content original rows distinct with their own edge statuses and source endpoints', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('synthetic source unavailable'))
  vi.stubGlobal('$fetch', fetch)
  const repeated = { ...row, platformRows: repeatedRelations, correspondences: [
    { id: 6, relationId: 106, role: 'supports_award', status: 'confirmed' },
    { id: 2, relationId: 102, role: 'context_only', status: 'confirmed' },
    { id: 1, relationId: 101, role: 'context_only', status: 'rejected' },
    { id: 4, relationId: 104, role: 'context_only', status: 'unlinked' },
    { id: 5, relationId: 105, role: 'context_only', status: 'unlinked' },
    { id: 3, relationId: 103, role: 'context_only', status: 'rejected' },
  ] } as unknown as RecordComparisonResult['rows'][number]
  const wrapper = mount(ComparisonEventRow, { props: { row: repeated, returnTo: '/comparison?mode=record' }, global: { stubs: sourceDialogStubs } })
  mounted.push(wrapper)
  const items = wrapper.findAll('li[data-relation-id]')
  expect(items).toHaveLength(6)
  const expected = [
    ['查询 #7 · 原行 1 · 记录 #101', '同批次流程背景 · 已拒绝', 101],
    ['查询 #7 · 原行 2 · 记录 #102', '同批次流程背景 · 已确认', 102],
    ['查询 #8 · 原行 1 · 记录 #103', '同批次流程背景 · 已拒绝', 103],
    ['查询 #8 · 原行 2 · 记录 #104', '同批次流程背景 · 已解除', 104],
    ['查询 #9 · 原行 1 · 记录 #105', '同批次流程背景 · 已解除', 105],
    ['查询 #9 · 原行 2 · 记录 #106', '支持认定事件 · 已确认', 106],
  ] as const
  for (const [index, [locator, status, id]] of expected.entries()) {
    expect(items[index]!.text()).toContain(locator)
    expect(items[index]!.findAll('[data-slot="badge"]').map(badge => badge.text())).toEqual([status])
    await items[index]!.get('button').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith(`/api/roster/correspondences/relations/${id}`)
  }
  expect(fetch).toHaveBeenCalledTimes(6)
})

it('keeps duplicate unlinked evidence rows separately located and opens every original source endpoint', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('synthetic source unavailable'))
  vi.stubGlobal('$fetch', fetch)
  const repeated = { ...result, platformWithoutOfficial: { total: 6, rows: repeatedRelations.map(relation => ({ relation, qualification: 'unresolved', reasons: [] })) } } as unknown as RecordComparisonResult
  const wrapper = mount(ComparisonEvidence, { props: { result: repeated, returnTo: '/comparison?mode=record' }, global: { stubs: sourceDialogStubs } })
  mounted.push(wrapper)
  const items = wrapper.findAll('[data-testid="record-platform-unlinked"] li')
  expect(items).toHaveLength(6)
  for (const [index, id] of [101, 102, 103, 104, 105, 106].entries()) {
    expect(items[index]!.text()).toContain(`查询 #${[7, 7, 8, 8, 9, 9][index]} · 原行 ${index % 2 + 1} · 记录 #${id}`)
    await items[index]!.get('button').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenLastCalledWith(`/api/roster/correspondences/relations/${id}`)
  }
  expect(fetch).toHaveBeenCalledTimes(6)
})

it('explains source-wide count totals stay unchanged by classification filters and pagination', () => {
  const wrapper = mount(ComparisonEvidence, { props: { result: { ...result, total: 1, counts: { ...result.counts, distinctEvents: 12 } }, returnTo: '/comparison?mode=record&classification=historical_conflict' }, global: { stubs: { SourceReader: true } } })
  mounted.push(wrapper)
  expect(wrapper.get('[aria-label="记录级计数"] strong').text()).toBe('12')
  expect(wrapper.text()).toContain('均按所选来源全集计数，不随事件分类筛选或分页变化')
})
