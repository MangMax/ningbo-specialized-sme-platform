import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { importReceiptRedactor } from './import-receipt-redaction'

type Db = BetterSQLite3Database<typeof schema>
export type ImportReceiptAction = 'get' | 'items' | 'history' | 'request'
export class ImportReceiptError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message) }
}
/** Preserve the REST domain error codes inside MCP's tool-error envelope. */
export function importReceiptMcpResult<T>(run: () => T) {
  try { return run() }
  catch (error) {
    if (!(error instanceof ImportReceiptError)) throw error
    return { isError: true, structuredContent: { error: { code: error.code, message: error.message } } }
  }
}
const invalid = (message: string): never => { throw new ImportReceiptError(400, 'invalid_query', message) }
function integer(value: unknown, name: string, fallback?: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
  if (value === undefined && fallback !== undefined) return fallback
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^(0|[1-9]\d*)$/.test(String(value))) return invalid(`${name} must be an integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) return invalid(`${name} must be between ${min} and ${max}`)
  return number
}
interface ReceiptRow {
  batchId: number; idempotencyKey: string; status: string; sourceKind: string; sourceIdentity: string
  idempotencyKeyTruncated: number; sourceIdentityTruncated: number
  createdAt: string; committedAt: string | null; receiptId: number | null; operation: string | null
  completedAt: string | null; itemCount: number; written: number | null; skipped: number | null
  failed: number | null; evidenceRepointed: number | null
}
/** Exact SQL projections: neither default reads nor pagination load whole raw blobs into JS. */
export function readImportReceipt(db: Db, action: ImportReceiptAction, args: Record<string, unknown>) {
  const redact = importReceiptRedactor(db)
  return db.transaction(() => redact(readImportReceiptSnapshot(db, action, args)))
}
function readImportReceiptSnapshot(db: Db, action: ImportReceiptAction, args: Record<string, unknown>) {
  const allowed = new Set(['batchId', 'idempotencyKey', ...(action === 'history' ? [] : ['receiptId']), ...(action === 'history' || action === 'items' ? ['page', 'pageSize'] : []), ...(action === 'request' ? ['offset', 'maxBytes'] : [])])
  for (const key of Object.keys(args)) if (!allowed.has(key)) invalid('Unsupported query field')
  if (['batchId', 'idempotencyKey', 'receiptId'].filter(key => args[key] !== undefined).length !== 1) invalid('Supply exactly one batchId, idempotencyKey or receiptId')
  if (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.trim() || args.idempotencyKey.length > 4096)) invalid('Invalid idempotencyKey')
  const receiptId = args.receiptId === undefined ? undefined : integer(args.receiptId, 'receiptId')
  const condition = args.batchId !== undefined ? sql`b.id = ${integer(args.batchId, 'batchId')}` : receiptId !== undefined ? sql`b.id = (SELECT batch_id FROM import_receipt WHERE id = ${receiptId})` : sql`b.idempotency_key = ${args.idempotencyKey}`
  const row = db.get<ReceiptRow>(sql`
    SELECT b.id AS batchId, substr(b.idempotency_key, 1, 4096) AS idempotencyKey, length(b.idempotency_key) > 4096 AS idempotencyKeyTruncated,
      coalesce(r.status, b.status) AS status, b.source_kind AS sourceKind,
      substr(b.source_identity, 1, 4096) AS sourceIdentity, length(b.source_identity) > 4096 AS sourceIdentityTruncated,
      coalesce(r.created_at, b.created_at) AS createdAt, CASE WHEN r.id IS NULL THEN b.committed_at WHEN r.status = 'committed' THEN r.completed_at ELSE NULL END AS committedAt,
      r.id AS receiptId, r.operation, r.completed_at AS completedAt,
      coalesce(json_array_length(CASE WHEN r.id IS NULL THEN b.item_results ELSE r.item_results END), 0) AS itemCount,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.written') AS written,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.skipped') AS skipped,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.failed') AS failed,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.evidenceRepointed') AS evidenceRepointed
    FROM import_batch b LEFT JOIN import_receipt r ON r.id = ${receiptId === undefined ? sql`(SELECT id FROM import_receipt WHERE batch_id = b.id ORDER BY id DESC LIMIT 1)` : sql`${receiptId}`}
    WHERE ${condition} AND b.source_kind IN ('announcement', 'platform_export', 'alias_evidence')`)
  if (!row) throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found')
  if (action === 'get') {
    const { written, skipped, failed, evidenceRepointed, ...metadata } = row
    return { ...metadata, idempotencyKeyTruncated: !!row.idempotencyKeyTruncated, sourceIdentityTruncated: !!row.sourceIdentityTruncated, summary: written === null ? null : { written, skipped: skipped ?? 0, failed: failed ?? 0, evidenceRepointed: evidenceRepointed ?? 0 }, originalRequest: row.receiptId === null ? 'not_retained' : 'redacted' }
  }
  if (action === 'request') {
    const offset = integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER - 1, 0)
    const maxBytes = integer(args.maxBytes, 'maxBytes', 16384, 65536)
    if (row.receiptId === null) throw new ImportReceiptError(404, 'not_retained', 'Original request was not retained')
    const body = db.get<{ totalBytes: number; chunk: Buffer }>(sql`SELECT length(CAST(request_body AS BLOB)) AS totalBytes, substr(CAST(request_body AS BLOB), ${offset + 1}, ${maxBytes}) AS chunk FROM import_receipt WHERE id = ${row.receiptId}`)!
    if (offset > body.totalBytes) invalid('offset exceeds request bytes')
    return { batchId: row.batchId, receiptId: row.receiptId, redacted: true, encoding: 'base64', contentType: 'application/json; charset=utf-8', offset, totalBytes: body.totalBytes, nextOffset: offset + body.chunk.length < body.totalBytes ? offset + body.chunk.length : null, data: body.chunk.toString('base64') }
  }
  const page = integer(args.page, 'page', 1, 1000000)
  const pageSize = integer(args.pageSize, 'pageSize', 20, 50)
  const offset = (page - 1) * pageSize
  if (action === 'history') {
    const { total } = db.get<{ total: number }>(sql`SELECT count(*) AS total FROM import_receipt WHERE batch_id = ${row.batchId}`)!
    const rows = db.all(sql`SELECT id AS receiptId, batch_id AS batchId, operation, status, created_at AS createdAt, completed_at AS completedAt, coalesce(json_array_length(item_results), 0) AS itemCount FROM import_receipt WHERE batch_id = ${row.batchId} ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`)
    return { batchId: row.batchId, page, pageSize, total, rows }
  }
  const items = row.receiptId === null ? sql`(SELECT item_results FROM import_batch WHERE id = ${row.batchId})` : sql`(SELECT item_results FROM import_receipt WHERE id = ${row.receiptId})`
  const rows = db.all<{ index: number; ok: number; kind: string; ref: string; errorCode: string | null; errorField: string | null }>(sql`SELECT CAST(key AS INTEGER) AS "index", json_extract(value, '$.ok') AS ok, substr(json_extract(value, '$.kind'), 1, 128) AS kind, substr(json_extract(value, '$.ref'), 1, 256) AS ref, substr(json_extract(value, '$.error.code'), 1, 128) AS errorCode, substr(json_extract(value, '$.error.field'), 1, 128) AS errorField FROM json_each(${items}) ORDER BY CAST(key AS INTEGER) LIMIT ${pageSize} OFFSET ${offset}`)
  return { batchId: row.batchId, receiptId: row.receiptId, status: row.status, page, pageSize, total: row.itemCount, rows: rows.map(item => ({ ...item, ok: !!item.ok })) }
}
