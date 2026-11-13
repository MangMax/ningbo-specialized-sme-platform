/** Ingest/replay certification boundary. Never imported by business query modules. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { candidateScopeObservation as o } from './candidate-scope-schema'
import { captureCandidateScope, CANDIDATE_SCOPE_RULE } from './candidate-scope-capture'
import { sqliteConnection } from './target-connection'
import { ensureProcessStoredReady } from './process-stored-catalog'
export function candidateObservationValues<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, collection: typeof s.platformCollection.$inferSelect, sequenceNo: number) {
  if (db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !== 71609 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !==71610 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71611 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71612 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71613) return {}
  ensureProcessStoredReady(sqliteConnection(db))
  const found = db.select({ r: s.platformCollectionArchiveRef, a: s.platformArchiveValue }).from(s.platformCollectionArchiveRef)
    .innerJoin(s.platformArchiveValue, eq(s.platformArchiveValue.id, s.platformCollectionArchiveRef.archiveId))
    .where(and(eq(s.platformCollectionArchiveRef.ownerId, collection.id), eq(s.platformCollectionArchiveRef.field, 'collectionEvidence'))).get()
  if (!found) return { candidateScopeState: 'uncaptured' as const, candidateScopeError: 'missing_original_collection_evidence' }
  const {r, a} = found
  if (r.sealed !== 1 || (a.storageClass === 'null' ? a.bytes !== null || a.byteLength !== null || a.sha256 !== null
    : !a.bytes || a.bytes.length !== a.byteLength || createHash('sha256').update(a.bytes).digest('hex') !== a.sha256)) throw new Error('Candidate original evidence binding conflict')
  const captured = captureCandidateScope(sqliteConnection(db), { rdjb: collection.rdjb, titleCode: collection.titleCode, sequenceNo, evidence: a.bytes, evidenceStorage:a.storageClass })
  return {
    candidateScopeState: captured.state, candidateScopeMask: captured.mask, candidateScopeError: captured.error,
    candidateScopeRule: CANDIDATE_SCOPE_RULE, candidateScopeArchiveId: a.id,
    candidateScopeRdjb: collection.rdjb, candidateScopeTitleCode: collection.titleCode, candidateScopeSequenceNo: sequenceNo,
  }
}
/** Verify captured inputs/results during replay without rewriting any capture or hash. */
export function verifyCandidateObservation<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, observationId: number) {
  if (db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !== 71609 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version !==71610 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71611 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71612 && db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version!==71613) return
  const observation = db.select().from(o).where(eq(o.id, observationId)).get()
  const collection = observation && db.select().from(s.platformCollection).where(eq(s.platformCollection.id, observation.collectionId)).get()
  if (!observation || !collection) throw new Error('Candidate observation context missing')
  const expected = candidateObservationValues(db, collection, observation.sequenceNo)
  if (Object.entries(expected).some(([key,value]) => !isDeepStrictEqual(Reflect.get(observation,key), value))) throw new Error('Candidate capture replay conflict')
}
