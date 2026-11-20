// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import QueryAssessmentSummary from '../../../layers/sme-roster/app/components/evidence-review/QueryAssessmentSummary.vue'

const assessment = (patch: Record<string, unknown> = {}) => ({
  queryCoverage: { status: 'complete', sources: [], truncated: false },
  currentDecision: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', versionId: null, current: null },
  explanationValidity: { status: 'not_applicable', reasons: [], explanationId: null, evidenceQueryIds: [] },
  assessment: 'queried_unjudged', ...patch,
})
describe('explanation assessment public UI', () => {
  it('shows collected without a decision as unjudged rather than unqueried', () => {
    const view = mount(QueryAssessmentSummary, { props: { assessment: assessment() as any } })
    expect(view.text()).toContain('已查询 · 尚未判断')
    expect(view.text()).toContain('覆盖完整')
    expect(view.text()).not.toContain('未查询')
    expect(view.text()).toContain('尚无业务决定')
  })
})

describe('preserved decisions and gaps', () => {
  it('keeps the old unqueried decision readable beside its invalid premise', () => {
    const view = mount(QueryAssessmentSummary, { props: { assessment: assessment({
      currentDecision: { versionId: 82, current: { id: 82, status: 'not_queried', reasonNote: '原依据缺代码', measureCode: 'none' } },
      explanationValidity: { status: 'premise_invalid' }, assessment: 'decided',
    }) as any } })
    expect(view.text()).toContain('原依据缺代码')
    expect(view.text()).toContain('前提已失效 · 待复核')
    expect(view.text()).toContain('覆盖完整')
    expect(view.text()).toContain('当前决定 #82')
  })
  it('reveals partial interface conditions and unfinished pages without claiming zero rows', async () => {
    const view = mount(QueryAssessmentSummary, { props: { assessment: assessment({
      queryCoverage: { status: 'partial', truncated: true, sources: [{ queryId: 9, interface: 'recognized_list', status: 'partial', queriedAt: '2026-10-19', conditions: { uscc: 'TEST7', rddqrq: '2025' }, pages: [{ page: 1, status: 'success', fetchedCount: 20 }], unfinished: [{ rdjb: '2', page: 2, source: 'queryBusList' }], fullRange: false, subjectMatch: 'exact_uscc', outcome: 'unknown' }] }, assessment: 'unknown',
    }) as any } })
    await view.get('[data-testid="coverage-details"] [data-slot="accordion-trigger"]').trigger('click')
    await flushPromises()
    expect(view.text()).toContain('覆盖不完整')
    expect(view.text()).toContain('仅展示最近50次相关查询')
    expect(view.text()).toContain('未完成：已认定企业列表 · 专精特新中小企业 · 下一页 2')
    expect(view.text()).toContain('2025')
    expect(view.text()).toContain('下一页 2')
    expect(view.text()).toContain('结果未知')
    expect(view.text()).not.toMatch(/queryBusList|技术详情|查询 ID|TEST7/)
    expect(view.text()).not.toContain('完整查询无记录')
  })
})
