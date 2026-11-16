import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { createCurrentQualificationAssessmentReader, CURRENT_TITLES } from './current-qualification'

type Coordinate = { enterpriseId: number; titleCode: string; direction: string }
/** Current consumer overlay only. Source-presence comparisons and stored decisions
 * retain their original meaning. Each block shares v5 inputs and one as-of. */
export function currentDifferenceCoordinates<T extends Coordinate>(db: BetterSQLite3Database<typeof schema>, rows: T[], asOf = Date.now()): T[] {
 if (!rows.some(row => row.direction === 'extra_in_miit')) return rows
 const reader = createCurrentQualificationAssessmentReader((db as BetterSQLite3Database<typeof schema> & { $client: Database.Database }).$client)
 const suppressed = new Set<string>()
 for (const title of CURRENT_TITLES) {
  const ids = [...new Set(rows.filter(r => r.direction === 'extra_in_miit' && r.titleCode === title).map(r => r.enterpriseId))]
  for (let offset=0; offset<ids.length; offset+=100) {
   for (const [id, summary] of reader.readEffectiveTitleSummaries(ids.slice(offset,offset+100),asOf,title)) {
    if (summary.effectiveStatus === 'effective') suppressed.add(JSON.stringify([id,title]))
   }
  }
 }
 return rows.filter(r => r.direction !== 'extra_in_miit' || !suppressed.has(JSON.stringify([r.enterpriseId,r.titleCode])))
}
