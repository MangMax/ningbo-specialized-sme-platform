import { describe, expect, it } from 'vitest'
import {
  assessmentHeadline,
  decisionVersionActionLabel,
  directionLabel,
  headerCheckLabel,
  impactDecisionCoordinate,
  impactDecisionRoleLabel,
  impactOldDecisionText,
  impactReviewFormTitle,
  officialTitlesLabel,
} from '../../../layers/sme-roster/lib/roster/review-display'

const assessment = (patch: Record<string, unknown> = {}) => ({
  queryCoverage: { status: 'complete', sources: [], truncated: false },
  currentDecision: { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit', versionId: null, current: null },
  explanationValidity: { status: 'not_applicable', reasons: [], explanationId: null, evidenceQueryIds: [] },
  assessment: 'queried_unjudged',
  ...patch,
}) as any

describe('enterprise header identity and check time', () => {
  it('labels official titles separately and keeps one platform-query time axis', () => {
    expect(officialTitlesLabel([])).toBe('正式称号：暂无')
    expect(officialTitlesLabel(['专精特新中小企业'])).toBe('正式称号：专精特新中小企业')
    expect(headerCheckLabel(null)).toBe('平台查询时间：未记录')
    expect(headerCheckLabel('2026-10-19T10:00:00Z')).toBe('平台查询时间：2026-10-19')
  })
})

describe('decision history action summaries', () => {
  it('distinguishes first decision, append correction, withdrawal and legacy import', () => {
    expect(decisionVersionActionLabel({ lifecycleAction: 'replace', previousId: null })).toBe('首次决定')
    expect(decisionVersionActionLabel({ lifecycleAction: 'replace', previousId: 8 }))
      .toBe('追加更正 · 原决定 #8 保留')
    expect(decisionVersionActionLabel({ lifecycleAction: 'withdraw', previousId: 8 }))
      .toBe('撤回 · 当前决定已置空')
    expect(decisionVersionActionLabel({ lifecycleAction: null, previousId: null }))
      .toBe('历史导入 · 未纳入受管生命周期')
  })
})

describe('verification direction wording', () => {
  it('uses the matrix wording for both directions', () => {
    expect(directionLabel('missing_in_miit')).toBe('应纳未纳')
    expect(directionLabel('extra_in_miit')).toBe('平台多出')
  })
})

describe('reviewed decision summaries distinguish append corrections from maintain', () => {
  const decided = (current: Record<string, unknown>) => assessment({
    assessment: 'decided',
    queryCoverage: { status: 'complete', sources: [], truncated: false },
    currentDecision: { enterpriseId: 11, titleCode: 'specialized_sme', direction: 'missing_in_miit', versionId: current.id, current },
    explanationValidity: { status: 'valid' },
  })

  it('reports the replacement lineage from public decision fields instead of claiming reasons stayed unchanged', () => {
    const headline = assessmentHeadline(decided({ id: 35, lifecycleAction: 'replace', previousId: 10, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none' }))
    expect(headline.detail).toBe('已追加更正为新决定 #35；原决定 #10 保留。')
    expect(headline.detail).not.toContain('保持原样')
    expect(headline.label).toBe('当前决定已复核')
  })

  it('uses a neutral summary when the valid review does not prove a maintain action', () => {
    const headline = assessmentHeadline(decided({ id: 9, lifecycleAction: null, previousId: null, status: 'confirmed_no_diff', reasonCode: null, measureCode: 'none' }))
    expect(headline.detail).not.toContain('保持原样')
    expect(headline.detail).not.toContain('维持')
    expect(headline.detail).toContain('最近证据已登记复核')
  })

  it('does not call a newly created current decision the original decision in a reviewed queue row', () => {
    const row = {
      id: 13, enterpriseId: 11, titleCode: 'specialized_sme', direction: 'missing_in_miit',
      decisionId: 35, latestRevisionId: 12, reviewedRevisionId: 12, classification: 'evidence_changed',
      pending: false, lineage: 'current',
      oldDecision: { id: 35, lifecycleAction: 'replace', previousId: 10, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none' },
    } as any
    const text = impactOldDecisionText(row)
    expect(text).toContain('当前决定 #35（追加更正）')
    expect(text).toContain('复核前决定 #10 保留')
    expect(text).toContain('原因')
    expect(text).not.toContain('原决定 #35')
  })

  it('keeps the pending row pointing at the decision under review', () => {
    const row = {
      id: 4, enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit',
      decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'evidence_changed',
      pending: true, lineage: 'current', oldDecision: { id: 82, status: 'not_queried', reasonCode: null, measureCode: 'none' },
    } as any
    expect(impactOldDecisionText(row)).toContain('待复核的当前决定 #82')
  })
})

describe('impact decision coordinates follow lineage instead of the affected decision id alone', () => {
  const row = (patch: Record<string, unknown> = {}) => ({
    id: 10, enterpriseId: 9, titleCode: 'specialized_sme', direction: 'missing_in_miit',
    decisionId: 8, latestRevisionId: 10, reviewedRevisionId: 10, classification: 'evidence_changed',
    pending: false, lineage: 'historical',
    oldDecision: { id: 8, isCurrent: false, lifecycleAction: null, previousId: null, status: 'confirmed_no_diff', reasonCode: null, measureCode: 'none' },
    ...patch,
  }) as any

  it('never calls a historical, withdrawn or merged coordinate the current decision', () => {
    for (const lineage of ['historical', 'withdrawn', 'merged']) {
      const text = impactOldDecisionText(row({ lineage }))
      expect(text).not.toContain('当前决定')
      expect(text).toContain('#8')
    }
    expect(impactDecisionRoleLabel(row({ lineage: 'historical' }))).toBe('历史决定')
    expect(impactDecisionRoleLabel(row({ lineage: 'withdrawn' }))).toBe('已撤回决定')
    expect(impactDecisionRoleLabel(row({ lineage: 'merged' }))).toBe('归并前决定')
  })

  it('treats an explicitly non-current oldDecision as historical even if lineage says current', () => {
    const text = impactOldDecisionText(row({ lineage: 'current', pending: false }))
    expect(text).toContain('历史决定 #8')
    expect(text).not.toContain('当前决定 #8')
  })

  it('keeps a pending current decision as the decision under review', () => {
    const pending = row({
      lineage: 'current',
      pending: true,
      oldDecision: { id: 8, isCurrent: true, lifecycleAction: null, previousId: null, status: 'confirmed_no_diff', reasonCode: null, measureCode: 'none' },
    })
    expect(impactDecisionRoleLabel(pending)).toBe('待复核的当前决定')
    expect(impactOldDecisionText(pending)).toContain('待复核的当前决定 #8')
  })

  it('reports replace lineage only from the API previousId and never fabricates one', () => {
    const replace = row({
      lineage: 'current', pending: false, decisionId: 34,
      oldDecision: { id: 34, isCurrent: true, lifecycleAction: 'replace', previousId: 8, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none' },
    })
    expect(impactDecisionCoordinate(replace)).toBe('当前决定 #34（追加更正）· 复核前决定 #8 保留')
    const first = row({
      lineage: 'current', pending: false, decisionId: 34,
      oldDecision: { id: 34, isCurrent: true, lifecycleAction: 'replace', previousId: null, status: 'confirmed_reason', reasonCode: 'other', measureCode: 'none' },
    })
    expect(impactDecisionCoordinate(first)).toBe('当前决定 #34（首次决定）')
    expect(impactDecisionCoordinate(first)).not.toContain('复核前决定')
  })

  it('uses the same role wording for the review form title', () => {
    expect(impactReviewFormTitle(row({
      lineage: 'current',
      pending: true,
      oldDecision: { id: 8, isCurrent: true, lifecycleAction: null, previousId: null },
    }))).toBe('待复核的当前决定 #8')
    expect(impactReviewFormTitle(row({ lineage: 'historical' }))).toBe('历史决定 #8')
  })

  it('does not invent a current decision when the original text is unavailable', () => {
    const merged = row({ lineage: 'merged', oldDecision: null })
    const text = impactOldDecisionText(merged)
    expect(text).toContain('归并前决定 #8')
    expect(text).toContain('历史决定原文不可用')
    expect(text).not.toContain('当前决定')
  })
})
