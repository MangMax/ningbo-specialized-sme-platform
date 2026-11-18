import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { createCurrentQualificationAssessmentReader, CURRENT_TITLES, type CurrentQualificationAssessment, type CurrentQualificationSnapshot } from './current-qualification'

import { readPlatformQualificationFacts, type PlatformQualificationFact } from './platform-qualification'

type Coordinate = { enterpriseId: number; titleCode: string; inCurrentDifference: boolean }
export interface DifferenceQualification {
  qualification: NonNullable<CurrentQualificationAssessment['effectiveQualification']> | null
  /** Advice only: never a persisted review state or a qualification command. */
  suggestedAction: 'none' | 'collect_source_facts'
}

type AssessedTitle = { enterpriseId: number; assessment: CurrentQualificationAssessment }
const assessedTitles = (snapshot: CurrentQualificationSnapshot): AssessedTitle[] => snapshot.titles.map(assessment => ({ enterpriseId: snapshot.enterpriseId, assessment }))

/** Pure qualification/advice projection shared by independently owned reads. */
function projectDifferences<T extends Coordinate>(rows: T[], assessed: readonly AssessedTitle[], facts: readonly PlatformQualificationFact[], asOf: number): (T & DifferenceQualification)[] {
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

/** REST owns a single selected-page input plan; MCP keeps its stored-only view. */
export function explainCurrentDifferencePage<T extends Coordinate>(db: BetterSQLite3Database<typeof schema>, rows: T[], asOf: number) {
  const reader = createCurrentQualificationAssessmentReader((db as BetterSQLite3Database<typeof schema> & { $client: Database.Database }).$client)
  const inputs = reader.readDifferenceBatch(rows, asOf)
  return { rows: projectDifferences(rows, inputs.snapshots.flatMap(read => assessedTitles(read.snapshot)), inputs.platformFacts, asOf), coverages: inputs.coverages }
}

/** Enrich only selected differences. Qualification never changes source membership. */
export function explainCurrentDifferences<T extends Coordinate>(db: BetterSQLite3Database<typeof schema>, rows: T[], asOf = Date.now(), detail?: { snapshot: CurrentQualificationSnapshot; platformFacts: readonly PlatformQualificationFact[] }): (T & DifferenceQualification)[] {
  if (!rows.length) return []
  if (detail) {
    if (detail.snapshot.asOf !== new Date(asOf).toISOString() || rows.some(row => row.enterpriseId !== detail.snapshot.enterpriseId)) {
      throw new Error('Difference detail inputs require the same enterprise/asOf')
    }
    return projectDifferences(rows, assessedTitles(detail.snapshot), detail.platformFacts, asOf)
  }
  const reader = createCurrentQualificationAssessmentReader((db as BetterSQLite3Database<typeof schema> & { $client: Database.Database }).$client)
  const assessed: AssessedTitle[] = []
  const facts: PlatformQualificationFact[] = []
  for (const title of CURRENT_TITLES) {
    const ids = [...new Set(rows.filter(row => row.titleCode === title).map(row => row.enterpriseId))]
    for (let offset = 0; offset < ids.length; offset += 100) {
      const snapshots = reader.readCurrentBatch(ids.slice(offset, offset + 100), asOf, title)
      facts.push(...readPlatformQualificationFacts(db, snapshots.map(read => ({ enterpriseId: read.snapshot.enterpriseId, uscc: read.rows[0]?.uscc ?? '' }))).filter(fact => fact.title === title))
      for (const { snapshot } of snapshots) assessed.push(...assessedTitles(snapshot).filter(row => row.assessment.titleCode === title))
    }
  }
  return projectDifferences(rows, assessed, facts, asOf)
}
