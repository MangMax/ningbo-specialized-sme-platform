import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { captureOfficialEventRevision113 } from './evidence-impact-113'
type Db = BetterSQLite3Database<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Call inside the correction transaction, once per changed event (also for evidence corrections). */
export function advanceOfficialEventRevision(tx: Db | Tx, eventId: number, expectedRevision: number): number {
  const updated = tx.update(schema.recordEvent).set({ revision: expectedRevision + 1 })
    .where(and(eq(schema.recordEvent.id, eventId), eq(schema.recordEvent.revision, expectedRevision))).run()
  if (updated.changes !== 1) throw Object.assign(new Error('Official event revision changed'), { code: 'stale_revision', statusCode: 409 })
  captureOfficialEventRevision113(tx, eventId, expectedRevision, expectedRevision + 1)
  return expectedRevision + 1
}

/** Revision 1 preserves fingerprints saved before migration0016; later revisions prevent ABA revival. */
export function versionedOfficialEvent(event: typeof schema.recordEvent.$inferSelect) {
  const { revision, ...legacy } = event
  return revision <= 1 ? legacy : event
}
