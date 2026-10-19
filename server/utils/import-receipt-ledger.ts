import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import type { RosterImportRequest } from '../../lib/roster-import-client'
import { ensureBatchRow } from './roster-batch-ledger'
import { ImportReceiptError } from './import-receipts'
import { importReceiptRedactor } from './import-receipt-redaction'

type Db = BetterSQLite3Database<typeof schema>
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item ?? null)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** Keep the original import body/response protocol; add durable recovery bookkeeping. */
export function recordImportReceipt<T extends { status: string }>(db: Db, operation: 'preflight' | 'commit' | 'replay', request: RosterImportRequest, run: () => T): T {
  const batchRequest = operation === 'replay' ? { ...request, idempotencyKey: `${request.idempotencyKey}#repoint` } : request
  const normalized = { ...request, sourceSha256: request.sourceSha256 ?? null }
  const hash = createHash('sha256').update(canonical(normalized)).digest('hex')
  const redact = importReceiptRedactor(db)
  // Reserve before execution so a process lost during submission remains visibly processing.
  const attempt = db.transaction(() => {
    const existing = db.get<{ id: number; status: string; sourceKind: string; sourceIdentity: string; sourceSha256: string | null }>(sql`SELECT id, status, source_kind AS sourceKind, source_identity AS sourceIdentity, source_sha256 AS sourceSha256 FROM import_batch WHERE idempotency_key = ${batchRequest.idempotencyKey}`)
    if (existing && (existing.sourceKind !== request.sourceKind || existing.sourceIdentity !== request.sourceIdentity || existing.sourceSha256 !== (request.sourceSha256 ?? null))) throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different source')
    const previous = existing ? db.get<{ status: string; requestHash: string }>(sql`SELECT status, request_hash AS requestHash FROM import_receipt WHERE batch_id = ${existing.id} ORDER BY id DESC LIMIT 1`) : undefined
    // Explicit evidence replay remains a recalculating command, including reordered
    // equivalent source sets. Its historical receipts must not freeze that old protocol.
    if (operation !== 'replay' && previous && ['committed', 'processing'].includes(previous.status) && previous.requestHash !== hash) throw new ImportReceiptError(409, 'idempotency_conflict', 'Idempotency key belongs to a different request')
    if (existing?.status === 'committed' && operation !== 'replay') return null
    const batch = ensureBatchRow(db, batchRequest)
    return db.insert(schema.importReceipt).values({ batchId: batch.id, operation, requestHash: hash, requestBody: JSON.stringify(redact(normalized)), status: 'processing', createdAt: new Date().toISOString() }).returning({ id: schema.importReceipt.id }).get()
  })
  if (!attempt) return run()
  try {
    // Business changes, batch state and final receipt commit together. Failures returned by
    // the existing core retain its complete rollback semantics and corrected-key retry.
    return db.transaction(() => {
      const result = run()
      const stored = result as T & { items?: unknown; summary?: unknown; preflight?: { conflicts?: unknown[] } }
      db.update(schema.importReceipt).set({ status: result.status === 'replayed' ? 'committed' : result.status as 'preflight' | 'committed' | 'failed', summary: stored.summary ?? null, itemResults: redact(stored.items ?? stored.preflight?.conflicts ?? []), completedAt: new Date().toISOString() }).where(eq(schema.importReceipt.id, attempt.id)).run()
      return result
    })
  } catch (error) {
    db.update(schema.importReceipt).set({ status: 'failed', completedAt: new Date().toISOString() }).where(eq(schema.importReceipt.id, attempt.id)).run()
    throw error
  }
}
