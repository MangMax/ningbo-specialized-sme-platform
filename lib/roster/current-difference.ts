import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { createCurrentQualificationAssessmentReader, CURRENT_TITLES, type CurrentQualificationAssessment, type CurrentQualificationSnapshot } from './current-qualification'

import { readPlatformQualificationFacts, type PlatformQualificationFact } from './platform-qualification'

type Coordinate = { enterpriseId: number; titleCode: string; inCurrentDifference: boolean }
export interface DifferenceQualification {
  qualification: NonNullable<CurrentQualificationAssessment['effectiveQualification']> | null
  /** Advice only: never a persisted review state or a qualification command. */
  suggestedAction: 'none' | 'collect_source_facts'
}

/** Enrich only selected differences. Qualification never changes source membership. */
export function explainCurrentDifferences<T extends Coordinate>(db: BetterSQLite3Database<typeof schema>, rows: T[], asOf = Date.now(), detail?: { snapshot: CurrentQualificationSnapshot; platformFacts: readonly PlatformQualificationFact[] }): (T & DifferenceQualification)[] {
  if (!rows.length) return []
  const reader = detail ? undefined : createCurrentQualificationAssessmentReader((db as BetterSQLite3Database<typeof schema> & { $client: Database.Database }).$client)
  const platformGaps = new Map<string, boolean>()
  const assessments = new Map<string, CurrentQualificationAssessment>()
  if (detail && (detail.snapshot.asOf !== new Date(asOf).toISOString() || rows.some(row => row.enterpriseId !== detail.snapshot.enterpriseId))) {
    throw new Error('Difference detail inputs require the same enterprise/asOf')
  }
  for (const title of CURRENT_TITLES) {
    const ids = [...new Set(rows.filter(row => row.titleCode === title).map(row => row.enterpriseId))]
    for (let offset = 0; offset < ids.length; offset += 100) {
      const snapshots = detail ? [{ snapshot: detail.snapshot, rows: [] as { uscc: string | null }[] }] : reader!.readCurrentBatch(ids.slice(offset, offset + 100), asOf, title)
      const facts = detail ? detail.platformFacts : readPlatformQualificationFacts(db, snapshots.map(read => ({ enterpriseId: read.snapshot.enterpriseId, uscc: read.rows[0]?.uscc ?? '' })))
      for (const { snapshot } of snapshots) {
        const owned = facts.filter(fact => fact.enterpriseId === snapshot.enterpriseId && fact.title === title && (!fact.businessTime.value || fact.businessTime.value <= new Date(asOf + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)))
        const source = (['recognized_list','business_list','apply_list'] as const).find(source => owned.some(fact => fact.source === source))
        const relevant = owned.filter(fact => fact.source === source)
        // An explicit invalidation or a known period is already source evidence.
        // Gaps in an older lower-priority source do not reopen a settled source.
        platformGaps.set(JSON.stringify([snapshot.enterpriseId, title]), !relevant.length || relevant.some(fact => fact.conclusion === 'unknown' || fact.conclusion === 'passed' && fact.periodReason === 'period_unknown'))
        const assessment = snapshot.titles.find(row => row.titleCode === title)
        if (assessment) assessments.set(JSON.stringify([snapshot.enterpriseId, title]), assessment)
      }
    }
  }
  return rows.map(row => {
    const assessment = assessments.get(JSON.stringify([row.enterpriseId, row.titleCode]))
    const qualification = assessment?.effectiveQualification ?? null
    // A settled end of qualification is not a missing source. Only suggest
    // collection for an unrecognized title with an actual source/cycle gap.
    const missingFacts = assessment && (
      assessment.completeness.gaps.some(gap => ['missing_official_source', 'missing_cycle_semantics'].includes(gap)) ||
      !assessment.evidence.length && platformGaps.get(JSON.stringify([row.enterpriseId, row.titleCode])) === true
    )
    return { ...row, qualification, suggestedAction: row.inCurrentDifference && qualification?.status === 'unrecognized' && missingFacts ? 'collect_source_facts' : 'none' }
  })
}
