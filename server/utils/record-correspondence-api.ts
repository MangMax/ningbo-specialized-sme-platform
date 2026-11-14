import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { readApiToken, resolveApiAuth } from './api-auth'
import { importReceiptRedactor } from './import-receipt-redaction'
import { commitRecordCorrespondences, CorrespondenceError, getRecordCorrespondence, listRecordCorrespondences, pageRecordCorrespondences, pageRecordCorrespondenceAudit, preflightRecordCorrespondences, readRecordCorrespondenceBatch, type CorrespondenceFilter } from './record-correspondence'
import { detail, details, sourceReader, sanitizeEvidence, summaries, type SourceKind } from './record-correspondence-read'
import { discoverEventArchives } from './event-archive-discovery'
import { generateCandidates } from './record-correspondence-candidates'

type Db = BetterSQLite3Database<typeof schema>
export type CorrespondenceAction = 'discover' | 'list' | 'get' | 'audit' | 'source' | 'candidates' | 'preflight' | 'commit' | 'batch'
export interface CorrespondenceApiInput { action: CorrespondenceAction; method: string; query?: Record<string, unknown>; body?: unknown; id?: unknown; kind?: unknown; key?: unknown; headers?: Record<string, string | undefined> }
export interface CorrespondenceApiOutput { status: number; headers: Record<string, string>; body: unknown }
const headers = { 'cache-control': 'no-store' }
const positive = z.number().int().positive()
const edge = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('event_process'), eventId: positive, relationId: positive, role: z.enum(['supports_award', 'supports_review', 'context_only']) }),
  z.strictObject({ type: z.literal('event_recognized'), eventId: positive, relationId: positive, role: z.enum(['recognized_corrob', 'current_context']) }),
  z.strictObject({ type: z.literal('later_process'), enterpriseId: positive, titleCode: z.string().min(1), predecessorEventId: positive.nullish(), relationId: positive, role: z.enum(['followup_apply', 'followup_update', 'followup_review']) }),
  z.strictObject({ type: z.literal('event_export_context'), eventId: positive, exportRowId: positive, role: z.literal('current_snapshot_context') }),
  z.strictObject({ type: z.literal('process_export_context'), relationId: positive, exportRowId: positive, role: z.literal('current_snapshot_context') }),
  z.strictObject({ type: z.literal('recognized_export'), relationId: positive, exportRowId: positive, role: z.enum(['same_current_row', 'candidate_same_current_row']) }),
])
const operation = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('revalidate'), correspondenceId: positive, expectedRevision: positive }),
  z.strictObject({ action: z.literal('create'), edge, status: z.enum(['candidate', 'confirmed', 'rejected']) }),
  z.strictObject({ action: z.literal('decide'), correspondenceId: positive, expectedRevision: positive, status: z.enum(['confirmed', 'rejected', 'unlinked']) }),
  z.strictObject({ action: z.literal('correct'), correspondenceId: positive, expectedRevision: positive, edge }),
])
const decision = z.strictObject({ idempotencyKey: z.string().trim().min(1), sourceIdentity: z.string().trim().min(1), actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1) }), basis: z.string().trim().min(1), ruleId: z.string().trim().min(1), ruleVersion: z.string().trim().min(1), proofIds: z.array(positive).max(100).optional(), operations: z.array(operation).min(1) })
const candidate = z.strictObject({ eventId: positive.optional(), enterpriseId: positive.optional(), titleCode: z.string().min(1).optional(), queryIds: z.array(positive).default([]), exportBatchIds: z.array(positive).default([]), ruleVersion: z.string().trim().min(1), page: positive.default(1), pageSize: positive.max(200).default(50) }).refine(v => v.eventId ? !v.enterpriseId && !v.titleCode : !!v.enterpriseId && !!v.titleCode, 'Provide eventId or enterpriseId and titleCode').refine(v => v.queryIds.length + v.exportBatchIds.length > 0, 'Specify archived query or export batch IDs')
const sourceKinds = ['event', 'relation', 'export_row'] as const
function fail(status: number, code: string, message: string): CorrespondenceApiOutput { return { status, headers, body: { error: { code, message } } } }
function success(body: unknown): CorrespondenceApiOutput { return { status: 200, headers, body } }
function ok(body: unknown, redactors: ReadonlyArray<(text: string) => string>): CorrespondenceApiOutput { return success(sanitizeEvidence(body, redactors)) }
type PublishedEvent = NonNullable<ReturnType<typeof detail>['event']>
/** Visit this already-hydrated object's own fields in their original order.
 * Only a trusted event/evidence seam may identify its additive finalized slot. */
function sanitizePublishedObject(value: object, redactors: ReadonlyArray<(text: string) => string>, visit: (key: string, item: unknown) => unknown, finalizedKey?: 'publishedPresentation' | 'publishedName') {
  const entries: Array<[string, unknown]> = []
  for (const [key, item] of Object.entries(value)) {
    if (key === finalizedKey) {
      entries.push([key, item])
      continue
    }
    // Delegate both filtering and key redaction to the existing sanitizer.
    // A filtered key has no entry and its value is not visited.
    const safeKeys = Object.keys(sanitizeEvidence({ [key]: null }, redactors) as Record<string, null>)
    for (const safeKey of safeKeys) entries.push([safeKey, visit(key, item)])
  }
  return Object.fromEntries(entries)
}
function sanitizePublishedEvidenceItem<T extends { publishedName?: unknown }>(item: T, redactors: ReadonlyArray<(text: string) => string>) {
  return sanitizePublishedObject(item, redactors, (_key, value) => sanitizeEvidence(value, redactors), 'publishedName')
}
/** Typed child selection is explicit at reader-owned seams. Arbitrary raw
 * dictionaries, including same-name or same-shape objects, stay generic. */
function sanitizePublishedEvent(event: PublishedEvent | null, redactors: ReadonlyArray<(text: string) => string>) {
  if (!event) return null
  return sanitizePublishedObject(event, redactors, (key, value) => {
    if (key === 'evidence') return event.evidence.map(item => sanitizePublishedEvidenceItem(item, redactors))
    if (key === 'officialEvidence') return event.officialEvidence.map(item => sanitizePublishedEvidenceItem(item, redactors))
    return sanitizeEvidence(value, redactors)
  }, 'publishedPresentation')
}
function sanitizePublishedDetail(row: ReturnType<typeof detail>, redactors: ReadonlyArray<(text: string) => string>) {
  return sanitizePublishedObject(row, redactors, (key, value) => {
    if (key === 'event') return sanitizePublishedEvent(row.event, redactors)
    if (key === 'predecessorEvent') return sanitizePublishedEvent(row.predecessorEvent, redactors)
    return sanitizeEvidence(value, redactors)
  })
}
function int(value: unknown) { const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null }
function page(query: Record<string, unknown>) { const p = query.page == null ? 1 : int(query.page); const s = query.pageSize == null ? 50 : int(query.pageSize); return p && s && s <= 200 ? { page: p, pageSize: s } : null }
function scalar(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : null }
function ids(input: Record<string, unknown>, keys: string[]) { const result: Record<string, number> = {}; for (const key of keys) if (input[key] != null) { const value = int(input[key]); if (!value) return null; result[key] = value } return result }
function permitted(input: Record<string, unknown>, keys: string[]) { return Object.keys(input).every(key => keys.includes(key)) }
function auth(input: CorrespondenceApiInput, configured: string | null | undefined) { return resolveApiAuth({ given: readApiToken(input.headers), configured }).writeAuthorized }
export function handleRecordCorrespondenceRequest(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null; browserAuthorized?: boolean }): CorrespondenceApiOutput {
  return ['list', 'get', 'audit', 'source', 'candidates', 'discover'].includes(input.action)
    ? context.db.transaction(() => correspondenceSnapshot(input, context))
    : correspondenceSnapshot(input, context)
}
function correspondenceSnapshot(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null; browserAuthorized?: boolean }): CorrespondenceApiOutput {
  try {
    const { db } = context
    const write = ['preflight', 'commit', 'batch'].includes(input.action)
    if (write && context.browserAuthorized !== true && !auth(input, context.apiToken)) return fail(401, 'unauthorized', 'Configured API token required')
    const method = ['list', 'get', 'audit', 'source', 'batch'].includes(input.action) ? 'GET' : 'POST'
    if (input.method !== method) return fail(405, 'method_not_allowed', `${method} required`)
    // Resolve secrets before any preflight or commit side effect, so response
    // redaction cannot fail after a decision was written.
    const redact = importReceiptRedactor(db, { additionalSecrets: [context.apiToken] })
    const redactors = redact.knownRedactors
    if (input.action === 'list') {
      const query = input.query ?? {}; const paging = page(query)
      const keys = ['eventId', 'relationId', 'exportRowId', 'enterpriseId', 'titleCode', 'type', 'role', 'status', 'ruleVersion', 'page', 'pageSize', 'view']
      if (!paging || !permitted(query, keys)) return fail(400, 'invalid_request', 'Invalid list query')
      if (query.view != null && query.view !== 'summary') return fail(400, 'invalid_request', 'Invalid view')
      const numeric = ids(query, ['eventId', 'relationId', 'exportRowId', 'enterpriseId']); if (!numeric) return fail(400, 'invalid_request', 'Invalid source ID')
      const types = ['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export']
      const statuses = ['candidate', 'confirmed', 'rejected', 'unlinked']
      if (query.type != null && !types.includes(query.type as string) || query.status != null && !statuses.includes(query.status as string)) return fail(400, 'invalid_request', 'Invalid type or status')
      for (const key of ['titleCode', 'role', 'ruleVersion']) if (query[key] != null && !scalar(query[key])) return fail(400, 'invalid_request', `Invalid ${key}`)
      const filter = { ...numeric, ...(query.titleCode ? { titleCode: query.titleCode as string } : {}), ...(query.type ? { type: query.type as typeof types[number] } : {}), ...(query.status ? { status: query.status as typeof statuses[number] } : {}), ...(query.role ? { role: query.role as string } : {}), ...(query.ruleVersion ? { ruleVersion: query.ruleVersion as string } : {}) }
      const result = pageRecordCorrespondences(db, filter as CorrespondenceFilter, paging)
      if (query.view === 'summary') return ok({ ...result, rows: summaries(result.rows) }, redactors)
      const body = { ...result, rows: details(db, result.rows, redact) }
      return success(sanitizePublishedObject(body, redactors, (key, value) => key === 'rows'
        ? body.rows.map(row => sanitizePublishedDetail(row, redactors)) : sanitizeEvidence(value, redactors)))
    }
    if (input.action === 'discover') {
      const parsed = z.strictObject({ eventId: positive, page: positive.default(1), pageSize: positive.max(200).default(50), queryPage: positive.default(1), queryPageSize: positive.max(200).default(25) }).safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', 'Invalid event discovery request')
      const result = discoverEventArchives(db, parsed.data, redact)
      if (!result) return fail(404, 'not_found', 'Official award or review event not found')
      return success(sanitizePublishedObject(result, redactors, (key, value) => key === 'event'
        ? sanitizePublishedEvent(result.event, redactors) : sanitizeEvidence(value, redactors)))
    }
    if (input.action === 'candidates') {
      const parsed = candidate.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error))
      const result = generateCandidates(db, parsed.data)
      return result ? ok(result, redactors) : fail(404, 'not_found', 'Official event or enterprise not found')
    }
    if (input.action === 'preflight') {
      const parsed = decision.safeParse(input.body)
      return parsed.success ? ok(preflightRecordCorrespondences(db, parsed.data), redactors) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'commit') {
      const parsed = z.strictObject({ request: decision, planHash: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(input.body)
      return parsed.success ? ok(commitRecordCorrespondences(db, parsed.data.request, parsed.data.planHash), redactors) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'batch') {
      const key = scalar(input.key); if (!key) return fail(400, 'invalid_request', 'Idempotency key required')
      const receipt = readRecordCorrespondenceBatch(db, key)
      return receipt ? ok(receipt, redactors) : fail(404, 'not_found', 'Committed receipt not found')
    }
    const id = int(input.id); if (!id) return fail(400, 'invalid_request', 'Positive ID required')
    if (input.action === 'source') {
      if (!sourceKinds.includes(input.kind as SourceKind)) return fail(400, 'invalid_request', 'Invalid source kind')
      const rows = listRecordCorrespondences(db, input.kind === 'event' ? { anyEventId: id } : input.kind === 'relation' ? { relationId: id } : { exportRowId: id })
      const reader = sourceReader(db, rows, { kind: input.kind as SourceKind, id }, redact)
      const source = reader.read(input.kind as SourceKind, id)
      if (!source) return fail(404, 'not_found', 'Source row not found')
      const body = { source, correspondences: rows.map(reader.detail) }
      return success(sanitizePublishedObject(body, redactors, (key, value) => {
        if (key === 'source' && input.kind === 'event') return sanitizePublishedEvent(source as PublishedEvent, redactors)
        if (key === 'correspondences') return body.correspondences.map(row => sanitizePublishedDetail(row, redactors))
        return sanitizeEvidence(value, redactors)
      }))
    }
    if (input.action === 'get') {
      const row = getRecordCorrespondence(db, id)
      return row ? success(sanitizePublishedDetail(detail(db, row, redact), redactors)) : fail(404, 'not_found', 'Correspondence not found')
    }
    if (!db.select({ id: schema.recordCorrespondence.id }).from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.id, id)).get()) return fail(404, 'not_found', 'Correspondence not found')
    const paging = page(input.query ?? {}); if (!paging || !permitted(input.query ?? {}, ['page', 'pageSize'])) return fail(400, 'invalid_request', 'Invalid audit query')
    const result = pageRecordCorrespondenceAudit(db, id, paging)
    return ok({ ...result, rows: result.rows.map(({ evidence, ...row }) => ({ ...row, evidence: sanitizeEvidence(evidence) })) }, redactors)
  } catch (error) {
    if (error instanceof CorrespondenceError) return fail(error.status, error.code, error.message)
    throw error
  }
}
