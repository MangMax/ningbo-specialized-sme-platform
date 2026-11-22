import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { createCurrentQualificationAssessmentReader, CURRENT_TITLES, type CurrentQualificationSnapshot } from './current-qualification'
import { type PlatformQualificationFact } from './platform-qualification'
import { readPlatformQualificationFacts } from './platform-qualification-sqlite'
import { projectDifferences, type AssessedTitle, type Coordinate, type DifferenceQualification } from './current-difference'

const assessedTitles = (snapshot: CurrentQualificationSnapshot): AssessedTitle[] =>
  snapshot.titles.map(assessment => ({ enterpriseId: snapshot.enterpriseId, assessment }))

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
