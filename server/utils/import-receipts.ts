import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { importItemsReadSchema, officialReadQuery, type ImportItemsRead } from '../../layers/sme-roster/server/utils/official-evidence-read'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { importReceiptRedactor } from './import-receipt-redaction'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CURRENT_TITLES } from '../../layers/sme-roster/lib/roster/current-titles'
import type { RosterImportHistoricalQualificationDiagnostics } from '../../lib/roster-import-client'

type Db = BetterSQLite3Database<typeof schema>
export type ImportReceiptAction = 'get' | 'items' | 'history' | 'request'
export class ImportReceiptError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly requiredBytes?: number) { super(message) }
}
/** Preserve the REST domain error codes inside MCP's tool-error envelope. */
export function importReceiptMcpResult<T>(run: () => T) {
  try { return run() }
  catch (error) {
    if (!(error instanceof ImportReceiptError)) throw error
    return { isError: true, structuredContent: { error: { code: error.code, message: error.message, ...(error.requiredBytes===undefined?{}:{requiredBytes:error.requiredBytes}) } } }
  }
}
/** Preserve the same tool-error envelope for isolated asynchronous execution. */
export async function asyncImportReceiptMcpResult<T>(run: () => Promise<T>) {
  try { return await run() }
  catch (error) {
    if (!(error instanceof ImportReceiptError)) throw error
    return { isError: true, structuredContent: { error: { code: error.code, message: error.message, ...(error.requiredBytes===undefined?{}:{requiredBytes:error.requiredBytes}) } } }
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
  failed: number | null; evidenceRepointed: number | null; canonicalProjection: string | null
}
/** Exact SQL projections: neither default reads nor pagination load whole raw blobs into JS. */
export function readImportReceipt(db: Db, action: ImportReceiptAction, args: Record<string, unknown>) {
  if(action==='items' && args.projection!==undefined) {
    const parsed=importItemsReadSchema.safeParse(officialReadQuery(args))
    if(!parsed.success) return invalid('Invalid exact merge snapshot selector')
    const selector = parsed.data
    if(selector.projection==='qualification') {
      try { return db.transaction(()=>readQualificationProjection(db,selector)) }
      catch(error) {if(error instanceof ImportReceiptError) throw error; throw new ImportReceiptError(500,'internal_error','Exact qualification read failed')}
    }
    try { return db.transaction(()=>readMergeSnapshotProjection(db,selector)) }
    catch(error) {if(error instanceof ImportReceiptError) throw error; throw new ImportReceiptError(500,'internal_error','Exact snapshot read failed')}
  }
  const redact = importReceiptRedactor(db)
  return db.transaction(() => {
    const result = redact(readImportReceiptSnapshot(db, action, args))
    if (!qualificationObject(result)) throw new ImportReceiptError(500, 'internal_error', 'Receipt object unavailable')
    return result
  })
}

function qualificationObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function qualificationId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function qualificationKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
/** Validate the saved protocol, never recompute qualification or mint a new snapshot identity. */
function retainedQualificationSnapshot(value: unknown, enterpriseId: number): boolean {
  if (!qualificationObject(value) || !qualificationKeys(value, ['enterpriseId','asOf','ruleVersion','assessmentVersion','snapshotId','titles'])
    || value.enterpriseId !== enterpriseId || typeof value.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf))
    || typeof value.ruleVersion !== 'string' || !value.ruleVersion || typeof value.assessmentVersion !== 'string' || !value.assessmentVersion
    || typeof value.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotId)
    || !Array.isArray(value.titles) || value.titles.length !== CURRENT_TITLES.length) return false
  const codes = new Set<unknown>()
  for (const title of value.titles) {
    if (!qualificationObject(title) || !CURRENT_TITLES.some(code => code === title.titleCode) || codes.has(title.titleCode) || !qualificationObject(title.versions)) return false
    codes.add(title.titleCode)
    for (const key of ['facts','sources','decisions','observations']) {
      const digest = title.versions[key]
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false
    }
    if (typeof title.group !== 'string' || !['eligible','pending','excluded'].includes(title.group)
      || !['officialQualification','subject','region','platform','correspondence','completeness','shadow'].every(key => qualificationObject(title[key]))
      || !['cycles','evidence','sourceVersions','references','notes'].every(key => Array.isArray(title[key]))) return false
  }
  const scope = { enterpriseId: value.enterpriseId, asOf: value.asOf, ruleVersion: value.ruleVersion, assessmentVersion: value.assessmentVersion }
  return value.snapshotId === createHash('sha256').update(JSON.stringify([scope, value.titles])).digest('hex')
}
/** Only the exact server-owned summary slot is eligible; arbitrary item detail/raw stays legacy. */
function retainedQualificationReadback(value: unknown, enterpriseId: number, redact: ReturnType<typeof importReceiptRedactor>): Record<string, unknown> {
  const unavailable = { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId } }
  if (!qualificationObject(value) || value.stage !== 'after') return unavailable
  if (value.status === 'captured') {
    if (!qualificationKeys(value, ['stage','status','target','assessment']) || !qualificationObject(value.target)
      || !qualificationKeys(value.target, ['enterpriseId']) || value.target.enterpriseId !== enterpriseId
      || !retainedQualificationSnapshot(value.assessment, enterpriseId)) return unavailable
    const redacted = redact(value)
    // Current secrets may change since capture. No partial/raw fallback or replacement digest.
    if (!isDeepStrictEqual(value, redacted) || JSON.stringify(value) !== JSON.stringify(redacted)) return unavailable
    return value
  }
  if (value.status === 'not_retained' && value.target === null) {
    if (typeof value.reason === 'string' && ['legacy_receipt','no_targets','scope_not_established'].includes(value.reason)
      && qualificationKeys(value, ['stage','status','reason','target'])) return value
    if (value.reason === 'multiple_targets' && qualificationKeys(value, ['stage','status','reason','target','enterpriseIds'])
      && Array.isArray(value.enterpriseIds) && value.enterpriseIds.length > 1 && value.enterpriseIds.every(qualificationId)
      && new Set(value.enterpriseIds).size === value.enterpriseIds.length && value.enterpriseIds.includes(enterpriseId)) return value
  }
  if (value.status === 'unavailable' && qualificationObject(value.target) && qualificationKeys(value.target, ['enterpriseId']) && value.target.enterpriseId === enterpriseId) {
    if (value.reason === 'read_unavailable' && qualificationKeys(value, ['stage','status','reason','target'])) return value
    if (value.reason === 'response_limit' && qualificationKeys(value, ['stage','status','reason','target','requiredBytes']) && qualificationId(value.requiredBytes)) return value
  }
  return unavailable
}
const historicalDiagnosticValue = z.union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.string(), z.null()])
const historicalDiagnosticSchema = z.strictObject({
  ref: z.string().max(64).regex(/^record:(0|[1-9]\d*)#(0|[1-9]\d*)$/),
  eventType: z.enum(['award','review','nurture','maintain']),
  values: z.strictObject({ year: historicalDiagnosticValue, decidedYear: historicalDiagnosticValue, batchSeq: historicalDiagnosticValue, reviewOutcome: historicalDiagnosticValue }),
  fieldGaps: z.array(z.strictObject({ field: z.enum(['year','decidedYear','batchSeq','reviewOutcome']), valueState: z.enum(['unknown','blank','invalid']), inputState: z.enum(['omitted','null','provided']) })).max(4)
    .refine(gaps => new Set(gaps.map(gap => gap.field)).size === gaps.length),
})
const historicalDiagnosticsSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('captured'), items: z.array(historicalDiagnosticSchema) }),
  z.strictObject({ status: z.literal('not_retained'), reason: z.literal('legacy_receipt') }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('read_unavailable') }),
])
function retainedQualificationDiagnostics(value: unknown, binding: { itemIndex: number; ref: string; enterpriseId: number; recordId: number; candidateRef: string }, digest: string, redact: ReturnType<typeof importReceiptRedactor>): RosterImportHistoricalQualificationDiagnostics {
  const unavailable = { status: 'unavailable' as const, reason: 'read_unavailable' as const }
  if (!/^record:(0|[1-9]\d*)$/.test(binding.candidateRef) || !Number.isSafeInteger(Number(binding.candidateRef.slice(7))) || !/^[a-f0-9]{64}$/.test(digest)) return unavailable
  const parsed = historicalDiagnosticsSchema.safeParse(value)
  if (!parsed.success || JSON.stringify(value) !== JSON.stringify(parsed.data)) return unavailable
  if (parsed.data.status === 'captured' && parsed.data.items.some((diagnostic, eventIndex) => diagnostic.ref !== `${binding.candidateRef}#${eventIndex}`)) return unavailable
  if (digest !== createHash('sha256').update(JSON.stringify([binding, value])).digest('hex')) return unavailable
  if (parsed.data.status === 'captured') {
    const redacted = redact(value)
    if (!isDeepStrictEqual(value, redacted) || JSON.stringify(value) !== JSON.stringify(redacted)) return unavailable
  }
  return parsed.data
}
/** One exact source/item; all raw JSON and length/type gates stay inside SQLite. */
function readQualificationProjection(db: Db, args: ImportItemsRead) {
  const source = args.source!, sourceId = (source === 'private_batch' ? args.batchId : args.receiptId)!, itemIndex = args.itemIndex!
  const maxBytes = args.maxBytes ?? 65536
  const sourceQuery = source === 'private_batch'
    ? sql`SELECT b.id AS batch_id,NULL AS receipt_id,b.status,b.status AS batch_status,b.source_kind,'commit' AS operation,b.item_results,b.summary FROM import_batch b WHERE b.id=${sourceId}`
    : sql`SELECT b.id AS batch_id,r.id AS receipt_id,r.status,b.status AS batch_status,b.source_kind,r.operation,r.item_results,r.summary FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE r.id=${sourceId}`
  const itemPath = `$[${itemIndex}]`
  const diagnosticPath = `$.qualificationDiagnosticsByItem."${itemIndex}"`
  const row = db.get<{ batchId: number; receiptId: number | null; itemType: string | null; validSource: number; validItem: number; enterpriseId: number | null; recordId: number | null; recordBound: number; captureMissing: number; payload: string | null; diagnosticsMissing: number; diagnosticsBound: number; candidateRef: string | null; diagnosticsDigest: string | null; diagnosticsPayload: string | null }>(sql`
    WITH source_row AS (${sourceQuery}), normalized AS (
      SELECT *,CASE WHEN json_valid(item_results) THEN item_results ELSE 'null' END AS items,
        CASE WHEN json_valid(summary) THEN summary ELSE 'false' END AS saved_summary FROM source_row
    ), selected AS (
      SELECT *,json_type(items,${itemPath}) AS item_type,
        CASE WHEN json_type(items,${itemPath})='object' THEN json_extract(items,${itemPath}) ELSE '{}' END AS item,
        json_type(saved_summary,'$.qualificationReadback') AS capture_type,
        CASE WHEN json_type(saved_summary,'$.qualificationReadback')='object' THEN json_extract(saved_summary,'$.qualificationReadback') ELSE NULL END AS capture,
        json_type(saved_summary,'$.qualificationDiagnosticsByItem') AS diagnostics_type,
        CASE WHEN json_type(saved_summary,${diagnosticPath})='object' THEN json_extract(saved_summary,${diagnosticPath}) ELSE '{}' END AS diagnostic_entry FROM normalized
    ) SELECT batch_id AS batchId,receipt_id AS receiptId,item_type AS itemType,
      coalesce(status='committed' AND batch_status='committed' AND operation='commit' AND source_kind='announcement',0) AS validSource,
      coalesce(item_type='object' AND json_type(item,'$.ok')='true' AND json_type(item,'$.kind')='text' AND json_extract(item,'$.kind')='record_event'
        AND json_type(item,'$.detail.enterpriseId')='integer' AND json_extract(item,'$.detail.enterpriseId') BETWEEN 1 AND 9007199254740991,0) AS validItem,
      CASE WHEN json_type(item,'$.detail.enterpriseId')='integer' AND json_extract(item,'$.detail.enterpriseId') BETWEEN 1 AND 9007199254740991 THEN json_extract(item,'$.detail.enterpriseId') ELSE NULL END AS enterpriseId,
      CASE WHEN json_type(item,'$.detail.recordId')='integer' AND json_extract(item,'$.detail.recordId') BETWEEN 1 AND 9007199254740991 THEN json_extract(item,'$.detail.recordId') ELSE NULL END AS recordId,
      coalesce(json_type(item,'$.detail.recordId')='integer' AND json_extract(item,'$.detail.recordId') BETWEEN 1 AND 9007199254740991
        AND json_type(item,'$.ref')='text' AND json_extract(item,'$.ref')='record:'||json_extract(item,'$.detail.recordId'),0) AS recordBound,
      coalesce((summary IS NULL OR json_type(saved_summary)='null' OR json_type(saved_summary)='object' AND (capture_type IS NULL OR capture_type='null')),0) AS captureMissing,
      CASE WHEN capture_type='object' AND length(CAST(capture AS BLOB))<=65536 THEN capture ELSE NULL END AS payload,
      coalesce(summary IS NULL OR json_type(saved_summary)='null' OR json_type(saved_summary)='object' AND diagnostics_type IS NULL,0) AS diagnosticsMissing,
      coalesce(diagnostics_type='object' AND (SELECT count(*) FROM json_each(diagnostic_entry))=7
        AND json_type(diagnostic_entry,'$.itemIndex')='integer' AND json_extract(diagnostic_entry,'$.itemIndex')=${itemIndex}
        AND json_type(diagnostic_entry,'$.ref')='text' AND json_extract(diagnostic_entry,'$.ref')=json_extract(item,'$.ref')
        AND json_type(diagnostic_entry,'$.enterpriseId')='integer' AND json_extract(diagnostic_entry,'$.enterpriseId')=json_extract(item,'$.detail.enterpriseId')
        AND json_type(diagnostic_entry,'$.recordId')='integer' AND json_extract(diagnostic_entry,'$.recordId')=json_extract(item,'$.detail.recordId'),0) AS diagnosticsBound,
      CASE WHEN json_type(diagnostic_entry,'$.candidateRef')='text' AND length(CAST(json_extract(diagnostic_entry,'$.candidateRef') AS BLOB))<=32 THEN json_extract(diagnostic_entry,'$.candidateRef') ELSE NULL END AS candidateRef,
      CASE WHEN json_type(diagnostic_entry,'$.digest')='text' AND length(CAST(json_extract(diagnostic_entry,'$.digest') AS BLOB))=64 THEN json_extract(diagnostic_entry,'$.digest') ELSE NULL END AS diagnosticsDigest,
      CASE WHEN json_type(diagnostic_entry,'$.diagnostics')='object' AND length(CAST(json_extract(diagnostic_entry,'$.diagnostics') AS BLOB))<=65536 THEN json_extract(diagnostic_entry,'$.diagnostics') ELSE NULL END AS diagnosticsPayload FROM selected`)
  if (!row || row.itemType === null) throw new ImportReceiptError(404, 'not_found', 'Exact import source or item not found')
  if (!row.validSource || !row.validItem || !qualificationId(row.batchId) || row.receiptId !== null && !qualificationId(row.receiptId) || !qualificationId(row.enterpriseId)) {
    throw new ImportReceiptError(409, 'selector_mismatch', 'Exact announcement record item required')
  }
  const redact = importReceiptRedactor(db)
  let readback: Record<string, unknown>
  if (row.captureMissing) readback = { stage: 'after', status: 'not_retained', reason: 'legacy_receipt', target: null }
  else if (!row.recordBound || row.payload === null) readback = { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId: row.enterpriseId } }
  else {
    try { readback = retainedQualificationReadback(JSON.parse(row.payload), row.enterpriseId, redact) }
    catch { readback = { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId: row.enterpriseId } } }
  }
  let diagnostics: RosterImportHistoricalQualificationDiagnostics = row.diagnosticsMissing
    ? { status: 'not_retained', reason: 'legacy_receipt' } : { status: 'unavailable', reason: 'read_unavailable' }
  if (!row.diagnosticsMissing && row.recordBound && row.diagnosticsBound && qualificationId(row.recordId)
    && row.candidateRef !== null && row.diagnosticsDigest !== null && row.diagnosticsPayload !== null) {
    try {
      diagnostics = retainedQualificationDiagnostics(JSON.parse(row.diagnosticsPayload), { itemIndex, ref: `record:${row.recordId}`, enterpriseId: row.enterpriseId, recordId: row.recordId, candidateRef: row.candidateRef }, row.diagnosticsDigest, redact)
    } catch { diagnostics = { status: 'unavailable', reason: 'read_unavailable' } }
  }
  // This closed envelope contains no arbitrary legacy/raw text. Only a verified capture
  // may be delivered intact; rerunning generic redaction here could invalidate its digest.
  const envelope = { source, batchId: row.batchId, receiptId: row.receiptId, itemIndex, target: readback.target, qualificationReadback: readback, qualificationDiagnostics: diagnostics }
  const requiredBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  if (requiredBytes > maxBytes) throw new ImportReceiptError(413, 'response_limit', 'Qualification projection exceeds maxBytes', requiredBytes)
  return envelope
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
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.evidenceRepointed') AS evidenceRepointed,
      json_extract(CASE WHEN r.id IS NULL THEN b.summary ELSE r.summary END, '$.canonicalProjection') AS canonicalProjection
    FROM import_batch b LEFT JOIN import_receipt r ON r.id = ${receiptId === undefined ? sql`(SELECT id FROM import_receipt WHERE batch_id = b.id ORDER BY id DESC LIMIT 1)` : sql`${receiptId}`}
    WHERE ${condition} AND b.source_kind IN ('announcement', 'platform_export', 'platform_archive', 'alias_evidence')`)
  if (!row) throw new ImportReceiptError(404, 'not_found', 'Import batch or receipt not found')
  if (action === 'get') {
    const { written, skipped, failed, evidenceRepointed, canonicalProjection, ...metadata } = row
    return { ...metadata, idempotencyKeyTruncated: !!row.idempotencyKeyTruncated, sourceIdentityTruncated: !!row.sourceIdentityTruncated, summary: written === null ? null : { written, skipped: skipped ?? 0, failed: failed ?? 0, evidenceRepointed: evidenceRepointed ?? 0, ...(canonicalProjection ? { canonicalProjection: JSON.parse(canonicalProjection) } : {}) }, originalRequest: row.receiptId === null ? 'not_retained' : 'redacted' }
  }
  if (action === 'request') {
    const offset = integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER - 1, 0)
    const maxBytes = integer(args.maxBytes, 'maxBytes', 16384, 65536)
    if (row.receiptId === null) throw new ImportReceiptError(404, 'not_retained', 'Original request was not retained')
    const body = db.get<{ totalBytes: number; chunk: Buffer }>(sql`SELECT length(CAST(COALESCE((SELECT owner.request_body FROM import_receipt owner WHERE owner.id=import_receipt.body_receipt_id), request_body) AS BLOB)) AS totalBytes, substr(CAST(COALESCE((SELECT owner.request_body FROM import_receipt owner WHERE owner.id=import_receipt.body_receipt_id), request_body) AS BLOB), ${offset + 1}, ${maxBytes}) AS chunk FROM import_receipt WHERE id = ${row.receiptId}`)!
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

const cursorSchema=z.strictObject({source:z.enum(['private_batch','redacted_receipt']),sourceId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),itemIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),oldRecordId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),afterIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1)})
/** C owns only this exact historical selector. JSON source/item/fold CTEs never leave SQLite. */
function readMergeSnapshotProjection(db:Db,args:ImportItemsRead) {
  const source=args.source!,sourceId=(source==='private_batch'?args.batchId:args.receiptId)!,itemIndex=args.itemIndex!,oldRecordId=args.oldRecordId!
  const binding={source,sourceId,itemIndex,oldRecordId},maxBytes=args.maxBytes??16384,pageSize=args.pageSize??20
  let afterIndex=-1
  if(args.cursor!==undefined) {
    try {
      if(!/^[A-Za-z0-9_-]+$/.test(args.cursor)) invalid('Invalid bound event cursor')
      const decoded=Buffer.from(args.cursor,'base64url')
      if(decoded.toString('base64url')!==args.cursor) invalid('Invalid bound event cursor')
      const cursor=cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
      if(cursor.source!==source || cursor.sourceId!==sourceId || cursor.itemIndex!==itemIndex || cursor.oldRecordId!==oldRecordId) invalid('Event cursor does not match exact source selector')
      afterIndex=cursor.afterIndex
    } catch { invalid('Invalid or mismatched event cursor') }
  }
  const nextCursor=Buffer.from(JSON.stringify({...binding,afterIndex:afterIndex+pageSize})).toString('base64url')
  const sourceQuery=source==='private_batch'
    ? sql`SELECT b.id AS batch_id,NULL AS receipt_id,b.status,b.status AS batch_status,b.source_kind,CASE WHEN json_valid(b.item_results) THEN b.item_results ELSE 'null' END AS items FROM import_batch b WHERE b.id=${sourceId}`
    : sql`SELECT b.id AS batch_id,r.id AS receipt_id,r.status,b.status AS batch_status,b.source_kind,CASE WHEN json_valid(r.item_results) THEN r.item_results ELSE 'null' END AS items FROM import_receipt r JOIN import_batch b ON b.id=r.batch_id WHERE r.id=${sourceId}`
  const itemPath=`$[${itemIndex}]`
  const cte=sql`WITH source_row AS (${sourceQuery}),selected_json AS (
    SELECT *,json_type(items,${itemPath}) AS item_type,CASE WHEN json_type(items,${itemPath})='object' THEN json_extract(items,${itemPath}) ELSE '{}' END AS item FROM source_row
  ), selected_lineage AS (
    SELECT *,CASE WHEN json_type(item,'$.detail.lineage')='object' THEN json_extract(item,'$.detail.lineage') ELSE '{}' END AS lineage FROM selected_json
  ), folds AS (
    SELECT CASE WHEN f.type='object' THEN f.value ELSE '{}' END AS fold FROM selected_lineage s,
      json_each(CASE WHEN json_type(s.lineage,'$.recordsFolded')='array' THEN json_extract(s.lineage,'$.recordsFolded') ELSE '[]' END) f
    WHERE json_extract(CASE WHEN f.type='object' THEN f.value ELSE '{}' END,'$.fromRecordId')=${oldRecordId} LIMIT 2
  ), selected_fold AS (
    SELECT s.*,f.fold,CASE WHEN json_type(f.fold,'$.fromRecordSnapshot')='object' THEN json_extract(f.fold,'$.fromRecordSnapshot') ELSE '{}' END AS snapshot FROM selected_lineage s LEFT JOIN folds f ON 1
  )`
  const positive=(json:SQL,path:string)=>sql`(json_type(${json},${path})='integer' AND json_extract(${json},${path}) BETWEEN 1 AND 9007199254740991)`
  const fold=sql`fold`,lineage=sql`lineage`,snapshot=sql`snapshot`
  const snapshotTexts=['titleCode','source','nameRaw','usccRaw','district']
  const nullableTexts=['nameRaw','usccRaw','district']
  const fieldTypes=sql.join(snapshotTexts.map(name=>sql`json_type(snapshot,${'$.'+name}) ${sql.raw(nullableTexts.includes(name)?"IN ('text','null')":"='text'")}`),sql` AND `)
  const fieldLengths=sql.join(snapshotTexts.map(name=>sql`(json_type(snapshot,${'$.'+name})='null' OR (length(json_extract(snapshot,${'$.'+name}))<=4000 AND length(CAST(json_extract(snapshot,${'$.'+name}) AS BLOB))<=16000))`),sql` AND `)
  const qualityValid=sql`(json_type(snapshot,'$.qualityFlags')='null' OR (json_type(snapshot,'$.qualityFlags')='array' AND NOT EXISTS(SELECT 1 FROM json_each(snapshot,'$.qualityFlags') WHERE type<>'text')))`
  const qualityLengths=sql`NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(snapshot,'$.qualityFlags')='array' THEN json_extract(snapshot,'$.qualityFlags') ELSE '[]' END) WHERE length(value)>4000 OR length(CAST(value AS BLOB))>16000)`
  const status=sql`CASE
    WHEN NOT coalesce(status='committed' AND batch_status='committed' AND source_kind IN ('announcement','platform_export','platform_archive','alias_evidence') AND item_type='object' AND json_type(item,'$.ok')='true' AND json_type(item,'$.kind')='text' AND json_extract(item,'$.kind')='merge'
      AND ${positive(lineage,'$.fromEnterpriseId')} AND ${positive(lineage,'$.intoEnterpriseId')},0) THEN 'selector_mismatch'
    WHEN json_type(lineage,'$.recordsFolded') IS NULL OR json_type(lineage,'$.recordsFolded')='null' THEN 'not_retained'
    WHEN json_type(lineage,'$.recordsFolded')<>'array' THEN 'selector_mismatch'
    WHEN (SELECT count(*) FROM folds)>1 THEN 'ambiguity'
    WHEN fold IS NULL OR NOT coalesce(${positive(fold,'$.fromRecordId')} AND ${positive(fold,'$.intoRecordId')},0) THEN 'selector_mismatch'
    WHEN json_type(fold,'$.fromRecordSnapshot') IS NULL OR json_type(fold,'$.fromRecordSnapshot')='null' THEN 'not_retained'
    WHEN json_type(fold,'$.fromRecordSnapshot')<>'object' OR NOT coalesce(${positive(snapshot,'$.id')} AND ${positive(snapshot,'$.enterpriseId')},0)
      OR json_extract(snapshot,'$.id')<>${oldRecordId} OR json_extract(snapshot,'$.enterpriseId')<>json_extract(lineage,'$.fromEnterpriseId')
      OR NOT coalesce(${fieldTypes} AND ${qualityValid},0) OR json_extract(snapshot,'$.source') NOT IN ('jxj','miit') THEN 'selector_mismatch'
    WHEN ${Number(args.projection==='snapshot')} AND NOT (${fieldLengths} AND ${qualityLengths}) THEN 'field_limit'
    ELSE 'available' END`
  const base=sql`'formatVersion',1,'source',${source},'batchId',batch_id,'receiptId',receipt_id,'itemIndex',CAST(${itemIndex} AS INTEGER),'oldRecordId',CAST(${oldRecordId} AS INTEGER),'storedRedacted',json(${source==='redacted_receipt'?'true':'false'}),'responseRedacted',json('true')`
  const fixedSnapshot=sql`json_object('id',json_extract(snapshot,'$.id'),'enterpriseId',json_extract(snapshot,'$.enterpriseId'),'titleCode',json_extract(snapshot,'$.titleCode'),'source',json_extract(snapshot,'$.source'),'nameRaw',json_extract(snapshot,'$.nameRaw'),'usccRaw',json_extract(snapshot,'$.usccRaw'),'district',json_extract(snapshot,'$.district'),'qualityFlags',json(json_extract(snapshot,'$.qualityFlags')))`
  const events=sql`CASE WHEN json_type(fold,'$.eventIds')='array' THEN json_extract(fold,'$.eventIds') ELSE '[]' END`
  const eventStatus=sql`CASE WHEN availability<>'available' THEN availability
    WHEN json_type(fold,'$.eventIds') IS NULL OR json_type(fold,'$.eventIds')='null' THEN 'not_retained'
    WHEN json_type(fold,'$.eventIds')<>'array' OR EXISTS(SELECT 1 FROM json_each(${events}) WHERE type<>'integer' OR value<1 OR value>9007199254740991) THEN 'selector_mismatch'
    WHEN ${afterIndex}>=json_array_length(${events}) THEN 'invalid_cursor'
    ELSE 'available' END`
  const eventPage=sql`(SELECT json_group_array(value) FROM (SELECT value FROM json_each(${events}) WHERE CAST(key AS INTEGER)>${afterIndex} ORDER BY CAST(key AS INTEGER) LIMIT ${pageSize}))`
  const hasMore=sql`(SELECT count(*) FROM (SELECT key FROM json_each(${events}) WHERE CAST(key AS INTEGER)>${afterIndex} ORDER BY CAST(key AS INTEGER) LIMIT ${pageSize+1}))>${pageSize}`
  const body=args.projection==='snapshot'
    ? sql`CASE WHEN availability='available' THEN json_object(${base},'availability','available','origin',json_object('fromEnterpriseId',json_extract(lineage,'$.fromEnterpriseId'),'intoEnterpriseId',json_extract(lineage,'$.intoEnterpriseId'),'intoRecordId',json_extract(fold,'$.intoRecordId')),'snapshot',json(${fixedSnapshot})) ELSE json_object(${base},'availability',availability) END`
    : sql`CASE WHEN availability='available' THEN json_object(${base},'availability','available','eventIds',json(${eventPage}),'nextCursor',CASE WHEN ${hasMore} THEN ${nextCursor} ELSE NULL END) ELSE json_object(${base},'availability',availability) END`
  const result=db.get<{availability:string;requiredBytes:number;projection:string|null}>(sql`${cte}, checked AS (SELECT *,${status} AS availability FROM selected_fold LIMIT 1), ready AS (SELECT *,${args.projection==='eventIds'?eventStatus:sql`availability`} AS final_availability FROM checked), rendered AS (
    SELECT availability,${body} AS body FROM (SELECT batch_id,receipt_id,lineage,fold,snapshot,final_availability AS availability FROM ready)
  ) SELECT availability,length(CAST(body AS BLOB)) AS requiredBytes,
    CASE WHEN availability IN ('available','not_retained') AND length(CAST(body AS BLOB))<=${maxBytes} THEN body ELSE NULL END AS projection FROM rendered`)
  if(!result) throw new ImportReceiptError(404,'missing','Exact import source not found')
  if(result.availability==='invalid_cursor') invalid('Event cursor exceeds retained array')
  if(['selector_mismatch','ambiguity'].includes(result.availability)) throw new ImportReceiptError(409,result.availability,'Exact merge selector rejected')
  if(result.availability==='field_limit') throw new ImportReceiptError(413,'field_limit','Stored snapshot field exceeds 4000 characters')
  if(!result.projection) throw new ImportReceiptError(413,'response_limit','Snapshot projection exceeds maxBytes',result.requiredBytes)
  const parsed:unknown=JSON.parse(result.projection)
  // SQL bounds scalar/byte lengths first; JS checks exact UTF16 after finite materialization.
  const bounded=z.object({snapshot:z.object({titleCode:z.string().refine(value=>value.length<=4000),source:z.string().refine(value=>value.length<=4000),nameRaw:z.string().refine(value=>value.length<=4000).nullable(),usccRaw:z.string().refine(value=>value.length<=4000).nullable(),district:z.string().refine(value=>value.length<=4000).nullable(),qualityFlags:z.array(z.string().refine(value=>value.length<=4000)).nullable()}).optional()}).safeParse(parsed)
  if(!bounded.success) throw new ImportReceiptError(413,'field_limit','Stored snapshot field exceeds 4000 UTF16 characters')
  const redacted=importReceiptRedactor(db)(parsed)
  if(!qualificationObject(redacted)) throw new ImportReceiptError(500,'internal_error','Snapshot object unavailable')
  const finalBytes=Buffer.byteLength(JSON.stringify(redacted))
  if(finalBytes>maxBytes) throw new ImportReceiptError(413,'response_limit','Redacted snapshot projection exceeds maxBytes',finalBytes)
  return redacted
}
