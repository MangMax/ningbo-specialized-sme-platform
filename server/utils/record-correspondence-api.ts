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
/** Only these typed event slots contain finalized new facts. Arbitrary raw
 * dictionaries (even with the same key names) still pass through the old sanitizer. */
function sanitizePublishedEvent(event: PublishedEvent | null, redactors: ReadonlyArray<(text: string) => string>) {
  if (!event) return null
  const { publishedPresentation, evidence, officialEvidence, ...legacy } = event
  const oldEvidence = evidence.map(({ publishedName: _name, ...item }) => item)
  const oldOfficial = officialEvidence.map(({ publishedName: _name, ...item }) => item)
  const old = { ...legacy, evidence: oldEvidence, officialEvidence: oldOfficial }
  const safe = sanitizeEvidence(old, redactors) as typeof old
  return { ...safe, publishedPresentation,
    evidence: safe.evidence.map((item, i) => ({ ...item, ...(evidence[i]!.publishedName === undefined ? {} : { publishedName: evidence[i]!.publishedName }) })),
    officialEvidence: safe.officialEvidence.map((item, i) => ({ ...item, ...(officialEvidence[i]!.publishedName === undefined ? {} : { publishedName: officialEvidence[i]!.publishedName }) })),
  }
}
function sanitizePublishedDetail(row: ReturnType<typeof detail>, redactors: ReadonlyArray<(text: string) => string>) {
  const { event, predecessorEvent, ...legacy } = row
  return { ...sanitizeEvidence(legacy, redactors) as typeof legacy,
    event: sanitizePublishedEvent(event, redactors), predecessorEvent: sanitizePublishedEvent(predecessorEvent, redactors) }
}
function int(value: unknown) { const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null }
function page(query: Record<string, unknown>) { const p = query.page == null ? 1 : int(query.page); const s = query.pageSize == null ? 50 : int(query.pageSize); return p && s && s <= 200 ? { page: p, pageSize: s } : null }
function scalar(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : null }
function ids(input: Record<string, unknown>, keys: string[]) { const result: Record<string, number> = {}; for (const key of keys) if (input[key] != null) { const value = int(input[key]); if (!value) return null; result[key] = value } return result }
function permitted(input: Record<string, unknown>, keys: string[]) { return Object.keys(input).every(key => keys.includes(key)) }
function auth(input: CorrespondenceApiInput, configured: string | null | undefined) { return resolveApiAuth({ given: readApiToken(input.headers), configured }).writeAuthorized }
export function handleRecordCorrespondenceRequest(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null }): CorrespondenceApiOutput {
  return ['list', 'get', 'audit', 'source', 'candidates', 'discover'].includes(input.action)
    ? context.db.transaction(() => correspondenceSnapshot(input, context))
    : correspondenceSnapshot(input, context)
}
function correspondenceSnapshot(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null }): CorrespondenceApiOutput {
  try {
    const { db } = context
    const write = ['preflight', 'commit', 'batch'].includes(input.action)
    if (write && !auth(input, context.apiToken)) return fail(401, 'unauthorized', 'Configured API token required')
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
      const { rows, ...pagingResult } = result
      return success({ ...sanitizeEvidence(pagingResult, redactors) as typeof pagingResult, rows: details(db, rows, redact).map(row => sanitizePublishedDetail(row, redactors)) })
    }
    if (input.action === 'discover') {
      const parsed = z.strictObject({ eventId: positive, page: positive.default(1), pageSize: positive.max(200).default(50), queryPage: positive.default(1), queryPageSize: positive.max(200).default(25) }).safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', 'Invalid event discovery request')
      const result = discoverEventArchives(db, parsed.data, redact)
      if (!result) return fail(404, 'not_found', 'Official award or review event not found')
      const { event, ...legacy } = result
      return success({ ...sanitizeEvidence(legacy, redactors) as typeof legacy, event: sanitizePublishedEvent(event, redactors) })
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
      return source ? success({ source: input.kind === 'event' ? sanitizePublishedEvent(source as PublishedEvent, redactors) : sanitizeEvidence(source, redactors),
        correspondences: rows.map(reader.detail).map(row => sanitizePublishedDetail(row, redactors)) }) : fail(404, 'not_found', 'Source row not found')
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
