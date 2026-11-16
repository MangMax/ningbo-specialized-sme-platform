import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { createCurrentQualificationAssessmentReader, CURRENT_TITLES, type CurrentQualificationAssessment } from './current-qualification'

type Coordinate = { enterpriseId: number; titleCode: string; inCurrentDifference: boolean }
export interface DifferenceQualification {
  qualification: NonNullable<CurrentQualificationAssessment['effectiveQualification']> | null
  /** Advice only: never a persisted review state or a qualification command. */
  suggestedAction: 'none' | 'collect_source_facts'
}

/** Enrich only selected differences. Qualification never changes source membership. */
export function explainCurrentDifferences<T extends Coordinate>(db: BetterSQLite3Database<typeof schema>, rows: T[], asOf = Date.now()): (T & DifferenceQualification)[] {
  if (!rows.length) return []
  const reader = createCurrentQualificationAssessmentReader((db as BetterSQLite3Database<typeof schema> & { $client: Database.Database }).$client)
  const qualifications = new Map<string, DifferenceQualification['qualification']>()
  for (const title of CURRENT_TITLES) {
    const ids = [...new Set(rows.filter(row => row.titleCode === title).map(row => row.enterpriseId))]
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const { snapshot } of reader.readCurrentBatch(ids.slice(offset, offset + 100), asOf, title)) {
        qualifications.set(JSON.stringify([snapshot.enterpriseId, title]), snapshot.titles.find(row => row.titleCode === title)?.effectiveQualification ?? null)
      }
    }
  }
  return rows.map(row => {
    const qualification = qualifications.get(JSON.stringify([row.enterpriseId, row.titleCode])) ?? null
    return { ...row, qualification, suggestedAction: !row.inCurrentDifference || qualification?.status === 'effective' ? 'none' : 'collect_source_facts' }
  })
}
