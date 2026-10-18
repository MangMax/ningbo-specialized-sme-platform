// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
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
  platformWithoutOfficial: { rows: [{ relation, qualification: 'unresolved' }], total: 1 },
} as unknown as RecordComparisonResult
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

it('keeps positive same-subject rows visible while qualification stays unknown', async () => {
  const wrapper = mount(ComparisonEvidence, { props: { result, returnTo: '/comparison?mode=record' }, global: { stubs: { SourceReader: true } } })
  mounted.push(wrapper)
  await wrapper.get('[data-testid="record-current-consistency"] summary').trigger('click')
  expect(wrapper.get('[data-testid="record-current-consistency"]').text()).toContain('暂不可比较')
  expect(wrapper.get('[data-testid="record-current-consistency"]').text()).toContain('源行 12')
  expect(wrapper.get('[data-testid="record-comparison-coverage"]').text()).toContain('部分')
  expect(wrapper.get('[data-testid="record-platform-unlinked"]').text()).toContain('正式来源覆盖待核')
})

it('links the actual stored PDF page and event return context', () => {
  const wrapper = mount(ComparisonEventRow, { props: { row, returnTo: '/comparison?mode=record&queryIds=7' }, global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' }, SourceReader: true } } })
  mounted.push(wrapper)
  const pageLink = wrapper.findAll('a').find(link => link.text() === '第 3 页')
  expect(pageLink).toBeDefined()
  const target = pageLink!.attributes('href')!
  expect(target).toContain('/preview')
  expect(decodeURIComponent(target)).toContain('back=/comparison?mode=record&queryIds=7')
  expect(target).toContain('page=3')
})
