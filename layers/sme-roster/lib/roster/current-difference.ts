import type { CurrentQualificationAssessment } from './current-qualification-model'
import type { PlatformQualificationFact } from './platform-qualification'

export type Coordinate = { enterpriseId: number; titleCode: string; inCurrentDifference: boolean }
export interface DifferenceQualification {
  qualification: NonNullable<CurrentQualificationAssessment['effectiveQualification']> | null
  /** Advice only: never a persisted review state or a qualification command. */
  suggestedAction: 'none' | 'collect_source_facts'
}

export type AssessedTitle = { enterpriseId: number; assessment: CurrentQualificationAssessment }

/** Pure qualification/advice projection shared by independently owned reads. */
export function projectDifferences<T extends Coordinate>(rows: T[], assessed: readonly AssessedTitle[], facts: readonly PlatformQualificationFact[], asOf: number): (T & DifferenceQualification)[] {
  const assessments = new Map(assessed.map(({ enterpriseId, assessment }) => [JSON.stringify([enterpriseId, assessment.titleCode]), assessment]))
  const at = new Date(asOf + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)
  return rows.map(row => {
    const assessment = assessments.get(JSON.stringify([row.enterpriseId, row.titleCode]))
    const qualification = assessment?.effectiveQualification ?? null
    const owned = facts.filter(fact => fact.enterpriseId === row.enterpriseId && fact.title === row.titleCode && (!fact.businessTime.value || fact.businessTime.value <= at))
    const source = (['recognized_list','business_list','apply_list'] as const).find(source => owned.some(fact => fact.source === source))
    const relevant = owned.filter(fact => fact.source === source)
    // An explicit invalidation or known period settles this source; gaps in
    // older lower-priority sources do not reopen it.
    const platformGap = !relevant.length || relevant.some(fact => fact.conclusion === 'unknown' || fact.conclusion === 'passed' && fact.periodReason === 'period_unknown')
    const missingFacts = assessment && (
      assessment.completeness.gaps.some(gap => ['missing_official_source', 'missing_cycle_semantics'].includes(gap)) ||
      !assessment.evidence.length && platformGap
    )
    return { ...row, qualification, suggestedAction: row.inCurrentDifference && qualification?.status === 'unrecognized' && missingFacts ? 'collect_source_facts' : 'none' }
  })
}
