import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'

/** Current revisions and their live dependencies in one bounded query. No command
 * reader here: command validation performs individual lookups for atomic writes. */
export function readTitleCycleDispositionInputs(db: Pick<BetterSQLite3Database<typeof s>, 'select'>, ids: readonly number[]) {
  const d = s.titleCycleDispositionRevision, e = s.recordEvent, r = s.record, f = s.storedFile
  return Map.groupBy(db.select({ disposition: d, file: f, cycle: e, record: r }).from(d)
    .leftJoin(f, eq(f.id, d.sourceFileId)).leftJoin(e, eq(e.id, d.cycleEventId)).leftJoin(r, eq(r.id, e.recordId))
    .where(and(inArray(d.enterpriseId, [...ids]), sql`${d.revision}=(select max(h.revision) from title_cycle_disposition_revision h where h.id=${d.id})`))
    .orderBy(d.revisionId).all(), row => row.disposition.enterpriseId)
}
