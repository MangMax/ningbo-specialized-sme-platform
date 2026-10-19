import { describe, expect, it } from 'vitest'
import {
  decisionVersionActionLabel,
  directionLabel,
  headerCheckLabel,
  officialTitlesLabel,
} from '../lib/roster/review-display'

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
