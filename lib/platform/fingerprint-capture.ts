/** Offline target-only evidence mechanism. No runtime selector. */
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { insertArchiveValue } from './target-archive'

export function requireCaptureForeignKeys<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>) {
  if(db.get<{foreign_keys:number}>(sql`PRAGMA foreign_keys`)?.foreign_keys!==1)throw new Error('fingerprint writes require foreign_keys=ON before entry')
}
export function capturePhase<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>) {
  requireCaptureForeignKeys(db)
  const phase=db.get<{user_version:number}>(sql`PRAGMA user_version`)?.user_version
  if(![71605,71606,71607].includes(phase!))throw new Error('Explicit finalized target required')
  return phase===71607
}
/** Must run inside the writer savepoint, serialized by its write transaction. */
export function nextObservationId<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>) {
  requireCaptureForeignKeys(db)
  const row=db.get<{id:number}>(sql`SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name='platform_business_observation'),0),coalesce((SELECT max(id) FROM platform_business_observation),0)) id`)
  const id=(row?.id??0)+1
  if(!Number.isSafeInteger(id)||id<1)throw new Error('Observation identity exhausted')
  return id
}
/** A RELEASE is provisional; caller owning the outer transaction must COMMIT/rollback. */
export function captureFingerprintBasis<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>, observationId:number, scheme:'target-command-v1'|'legacy-bootstrap-v1', bytes:Buffer) {
  if(!capturePhase(db))throw new Error('Explicit 71607 capture target required')
  return db.transaction(tx=>{
    const fingerprint=createHash('sha256').update(bytes).digest('hex')
    const archiveId=insertArchiveValue(tx,{storageClass:'blob',bytes,createdAt:null},{sha256:fingerprint})
    tx.insert(s.platformObservationFingerprintBasis).values({observationId,scheme,inputArchiveId:archiveId}).run()
    return fingerprint
  })
}

export function assertCapturedInput<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>,observationId:number,bytes:Buffer) {
 const b=s.platformObservationFingerprintBasis,a=s.platformArchiveValue
 const found=db.select({basis:b,value:a}).from(b).innerJoin(a,eq(a.id,b.inputArchiveId)).where(eq(b.observationId,observationId)).get()
 if(!found||found.basis.scheme!=='target-command-v1'||found.value.storageClass!=='blob'||!found.value.bytes?.equals(bytes)||found.value.byteLength!==bytes.length||found.value.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new Error('observation_payload_conflict: missing or changed captured basis')
}
