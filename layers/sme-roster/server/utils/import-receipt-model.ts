import { z } from 'zod'
import type { ImportItemsRead } from './official-evidence-read'
import type { ReceiptRedactor } from './import-receipt-redaction'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import type { RosterImportHistoricalQualificationDiagnostics } from '../../lib/roster-import-client'

export type ImportReceiptAction = 'get' | 'items' | 'history'

export class ImportReceiptError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly requiredBytes?: number) { super(message) }
}

export async function asyncImportReceiptMcpResult<T>(run: () => Promise<T>) {
  try { return await run() }
  catch (error) {
    if (!(error instanceof ImportReceiptError)) throw error
    return { isError: true, structuredContent: { error: { code: error.code, message: error.message, ...(error.requiredBytes===undefined?{}:{requiredBytes:error.requiredBytes}) } } }
  }
}

export const invalidImportReceiptQuery = (message: string): never => { throw new ImportReceiptError(400, 'invalid_query', message) }

export function importReceiptInteger(value: unknown, name: string, fallback?: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
  if (value === undefined && fallback !== undefined) return fallback
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^(0|[1-9]\d*)$/.test(String(value))) return invalidImportReceiptQuery(`${name} must be an integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) return invalidImportReceiptQuery(`${name} must be between ${min} and ${max}`)
  return number
}

export type ReceiptRow = {
  batchId: number; idempotencyKey: string; status: string; sourceKind: string; sourceIdentity: string
  idempotencyKeyTruncated: number; sourceIdentityTruncated: number
  createdAt: string; committedAt: string | null; receiptId: number | null; operation: string | null
  completedAt: string | null; itemCount: number; written: number | null; skipped: number | null
  failed: number | null; evidenceRepointed: number | null; canonicalProjection: string | null
}

export function qualificationObject(value: unknown): value is Record<string, unknown> {
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
function retainedQualificationReadback(value: unknown, enterpriseId: number, redact: ReceiptRedactor): Record<string, unknown> {
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

function retainedQualificationDiagnostics(value: unknown, binding: { itemIndex: number; ref: string; enterpriseId: number; recordId: number; candidateRef: string }, digest: string, redact: ReceiptRedactor): RosterImportHistoricalQualificationDiagnostics {
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

export type QualificationReceiptRow = { batchId: number; receiptId: number | null; itemType: string | null; validSource: number | boolean; validItem: number | boolean; enterpriseId: number | null; recordId: number | null; recordBound: number | boolean; captureMissing: number | boolean; payload: string | null; diagnosticsMissing: number | boolean; diagnosticsBound: number | boolean; candidateRef: string | null; diagnosticsDigest: string | null; diagnosticsPayload: string | null }

export function projectQualificationReceipt(row: QualificationReceiptRow | undefined, args: ImportItemsRead, redact: ReceiptRedactor) {
  const source = args.source!, itemIndex = args.itemIndex!, maxBytes = args.maxBytes ?? 65536
  if (!row || row.itemType === null) throw new ImportReceiptError(404, 'not_found', 'Exact import source or item not found')
  if (!row.validSource || !row.validItem || !qualificationId(row.batchId) || row.receiptId !== null && !qualificationId(row.receiptId) || !qualificationId(row.enterpriseId)) {
    throw new ImportReceiptError(409, 'selector_mismatch', 'Exact announcement record item required')
  }
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

export function parseImportReceiptSelector(action: ImportReceiptAction, args: Record<string, unknown>) {
  const allowed = new Set(['batchId', 'idempotencyKey', ...(action === 'history' ? [] : ['receiptId']), ...(action === 'history' || action === 'items' ? ['page', 'pageSize'] : [])])
  for (const key of Object.keys(args)) if (!allowed.has(key)) invalidImportReceiptQuery('Unsupported query field')
  if (['batchId', 'idempotencyKey', 'receiptId'].filter(key => args[key] !== undefined).length !== 1) invalidImportReceiptQuery('Supply exactly one batchId, idempotencyKey or receiptId')
  if (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.trim() || args.idempotencyKey.length > 4096)) invalidImportReceiptQuery('Invalid idempotencyKey')
  const receiptId = args.receiptId === undefined ? undefined : importReceiptInteger(args.receiptId, 'receiptId')
  return {
    receiptId,
    batchId: args.batchId === undefined ? undefined : importReceiptInteger(args.batchId, 'batchId'),
    key: args.idempotencyKey as string | undefined,
  }
}

export function projectImportReceiptMetadata(row: ReceiptRow) {
    const { written, skipped, failed, evidenceRepointed, canonicalProjection, ...metadata } = row
    return { ...metadata, idempotencyKeyTruncated: !!row.idempotencyKeyTruncated, sourceIdentityTruncated: !!row.sourceIdentityTruncated, summary: written === null ? null : { written, skipped: skipped ?? 0, failed: failed ?? 0, evidenceRepointed: evidenceRepointed ?? 0, ...(canonicalProjection ? { canonicalProjection: JSON.parse(canonicalProjection) } : {}) } }
}

const cursorSchema=z.strictObject({source:z.enum(['private_batch','redacted_receipt']),sourceId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),itemIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),oldRecordId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),afterIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1)})

export function mergeReceiptSelection(args: ImportItemsRead) {
  const source=args.source!,sourceId=(source==='private_batch'?args.batchId:args.receiptId)!,itemIndex=args.itemIndex!,oldRecordId=args.oldRecordId!
  const binding={source,sourceId,itemIndex,oldRecordId},maxBytes=args.maxBytes??16384,pageSize=args.pageSize??20
  let afterIndex=-1
  if(args.cursor!==undefined) {
    try {
      if(!/^[A-Za-z0-9_-]+$/.test(args.cursor)) invalidImportReceiptQuery('Invalid bound event cursor')
      const decoded=Buffer.from(args.cursor,'base64url')
      if(decoded.toString('base64url')!==args.cursor) invalidImportReceiptQuery('Invalid bound event cursor')
      const cursor=cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
      if(cursor.source!==source || cursor.sourceId!==sourceId || cursor.itemIndex!==itemIndex || cursor.oldRecordId!==oldRecordId) invalidImportReceiptQuery('Event cursor does not match exact source selector')
      afterIndex=cursor.afterIndex
    } catch { invalidImportReceiptQuery('Invalid or mismatched event cursor') }
  }
  const nextCursor=Buffer.from(JSON.stringify({...binding,afterIndex:afterIndex+pageSize})).toString('base64url')
  return { binding, maxBytes, pageSize, afterIndex, nextCursor }
}

export function projectMergeReceipt(result: { availability: string; requiredBytes: number; projection: string | null } | undefined, maxBytes: number, redactor: () => ReceiptRedactor) {
  if(!result) throw new ImportReceiptError(404,'missing','Exact import source not found')
  if(result.availability==='invalid_cursor') invalidImportReceiptQuery('Event cursor exceeds retained array')
  if(['selector_mismatch','ambiguity'].includes(result.availability)) throw new ImportReceiptError(409,result.availability,'Exact merge selector rejected')
  if(result.availability==='field_limit') throw new ImportReceiptError(413,'field_limit','Stored snapshot field exceeds 4000 characters')
  if(!result.projection) throw new ImportReceiptError(413,'response_limit','Snapshot projection exceeds maxBytes',result.requiredBytes)
  const parsed:unknown=JSON.parse(result.projection)
  // SQL bounds scalar/byte lengths first; JS checks exact UTF16 after finite materialization.
  const bounded=z.object({snapshot:z.object({titleCode:z.string().refine(value=>value.length<=4000),source:z.string().refine(value=>value.length<=4000),nameRaw:z.string().refine(value=>value.length<=4000).nullable(),usccRaw:z.string().refine(value=>value.length<=4000).nullable(),district:z.string().refine(value=>value.length<=4000).nullable(),qualityFlags:z.array(z.string().refine(value=>value.length<=4000)).nullable()}).optional()}).safeParse(parsed)
  if(!bounded.success) throw new ImportReceiptError(413,'field_limit','Stored snapshot field exceeds 4000 UTF16 characters')
  const redacted=redactor()(parsed)
  if(!qualificationObject(redacted)) throw new ImportReceiptError(500,'internal_error','Snapshot object unavailable')
  const finalBytes=Buffer.byteLength(JSON.stringify(redacted))
  if(finalBytes>maxBytes) throw new ImportReceiptError(413,'response_limit','Redacted snapshot projection exceeds maxBytes',finalBytes)
  return redacted
}
