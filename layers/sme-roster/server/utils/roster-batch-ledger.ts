import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'

type Db = BetterSQLite3Database<typeof schema>
type BatchSource = Pick<typeof schema.importBatch.$inferInsert, 'idempotencyKey' | 'sourceKind' | 'sourceIdentity' | 'sourceSha256'>

/** Shared RL-11 batch ledger for roster ingestion and record correspondence decisions. */
export function findBatchByKey(db: Db, idempotencyKey: string) {
  return db.select().from(schema.importBatch).where(eq(schema.importBatch.idempotencyKey, idempotencyKey)).get()
}

export function ensureBatchRow(db: Db, request: BatchSource) {
  const existing = findBatchByKey(db, request.idempotencyKey)
  if (existing) {
    if (existing.sourceKind !== request.sourceKind || existing.sourceIdentity !== request.sourceIdentity || existing.sourceSha256 !== (request.sourceSha256 ?? null)) {
      throw new Error('import_batch idempotency key belongs to a different source')
    }
    return existing
  }
  try {
    return db.insert(schema.importBatch).values({
      idempotencyKey: request.idempotencyKey,
      sourceKind: request.sourceKind,
      sourceIdentity: request.sourceIdentity,
      sourceSha256: request.sourceSha256 ?? null,
      status: 'preflight',
    }).returning().get()
  } catch (cause) {
    const raced = findBatchByKey(db, request.idempotencyKey)
    if (raced) {
      if (raced.sourceKind !== request.sourceKind || raced.sourceIdentity !== request.sourceIdentity || raced.sourceSha256 !== (request.sourceSha256 ?? null)) {
        throw new Error('import_batch idempotency key belongs to a different source')
      }
      return raced
    }
    throw cause
  }
}
