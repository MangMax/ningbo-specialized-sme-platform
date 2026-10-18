import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { readApiToken, resolveApiAuth } from './api-auth'
import { commitRecordCorrespondences, CorrespondenceError, listRecordCorrespondences, preflightRecordCorrespondences, readRecordCorrespondenceBatch, type CorrespondenceFilter } from './record-correspondence'
import { audit, detail, readSource, sanitizeEvidence, type SourceKind } from './record-correspondence-read'
import { generateCandidates } from './record-correspondence-candidates'

type Db = BetterSQLite3Database<typeof schema>
export type CorrespondenceAction = 'list' | 'get' | 'audit' | 'source' | 'candidates' | 'preflight' | 'commit' | 'batch'
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
  z.strictObject({ action: z.literal('create'), edge, status: z.enum(['candidate', 'confirmed']) }),
  z.strictObject({ action: z.literal('decide'), correspondenceId: positive, expectedRevision: positive, status: z.enum(['confirmed', 'rejected', 'unlinked']) }),
  z.strictObject({ action: z.literal('correct'), correspondenceId: positive, expectedRevision: positive, edge }),
])
const decision = z.strictObject({ idempotencyKey: z.string().trim().min(1), sourceIdentity: z.string().trim().min(1), actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1) }), basis: z.string().trim().min(1), ruleId: z.string().trim().min(1), ruleVersion: z.string().trim().min(1), proofIds: z.array(positive).max(100).optional(), operations: z.array(operation).min(1) })
const candidate = z.strictObject({ eventId: positive.optional(), enterpriseId: positive.optional(), titleCode: z.string().min(1).optional(), queryIds: z.array(positive).default([]), exportBatchIds: z.array(positive).default([]), ruleVersion: z.string().trim().min(1), page: positive.default(1), pageSize: positive.max(200).default(50) }).refine(v => v.eventId ? !v.enterpriseId && !v.titleCode : !!v.enterpriseId && !!v.titleCode, 'Provide eventId or enterpriseId and titleCode').refine(v => v.queryIds.length + v.exportBatchIds.length > 0, 'Specify archived query or export batch IDs')
const sourceKinds = ['event', 'relation', 'export_row'] as const
function fail(status: number, code: string, message: string): CorrespondenceApiOutput { return { status, headers, body: { error: { code, message } } } }
function ok(body: unknown): CorrespondenceApiOutput { return { status: 200, headers, body: sanitizeEvidence(body) } }
function int(value: unknown) { const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null }
function page(query: Record<string, unknown>) { const p = query.page == null ? 1 : int(query.page); const s = query.pageSize == null ? 50 : int(query.pageSize); return p && s && s <= 200 ? { page: p, pageSize: s } : null }
function scalar(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : null }
function ids(input: Record<string, unknown>, keys: string[]) { const result: Record<string, number> = {}; for (const key of keys) if (input[key] != null) { const value = int(input[key]); if (!value) return null; result[key] = value } return result }
function permitted(input: Record<string, unknown>, keys: string[]) { return Object.keys(input).every(key => keys.includes(key)) }
function paginate<T>(rows: T[], { page, pageSize }: { page: number; pageSize: number }) { return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize } }
function auth(input: CorrespondenceApiInput, configured: string | null | undefined) { return resolveApiAuth({ given: readApiToken(input.headers), configured }).writeAuthorized }
export function handleRecordCorrespondenceRequest(input: CorrespondenceApiInput, context: { db: Db; apiToken?: string | null }): CorrespondenceApiOutput {
  try {
    const { db } = context
    const write = ['preflight', 'commit', 'batch'].includes(input.action)
    if (write && !auth(input, context.apiToken)) return fail(401, 'unauthorized', 'Configured API token required')
    const method = ['list', 'get', 'audit', 'source', 'batch'].includes(input.action) ? 'GET' : 'POST'
    if (input.method !== method) return fail(405, 'method_not_allowed', `${method} required`)
    if (input.action === 'list') {
      const query = input.query ?? {}; const paging = page(query)
      const keys = ['eventId', 'relationId', 'exportRowId', 'enterpriseId', 'titleCode', 'type', 'role', 'status', 'ruleVersion', 'page', 'pageSize']
      if (!paging || !permitted(query, keys)) return fail(400, 'invalid_request', 'Invalid list query')
      const numeric = ids(query, ['eventId', 'relationId', 'exportRowId', 'enterpriseId']); if (!numeric) return fail(400, 'invalid_request', 'Invalid source ID')
      const types = ['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export']
      const statuses = ['candidate', 'confirmed', 'rejected', 'unlinked']
      if (query.type != null && !types.includes(query.type as string) || query.status != null && !statuses.includes(query.status as string)) return fail(400, 'invalid_request', 'Invalid type or status')
      for (const key of ['titleCode', 'role', 'ruleVersion']) if (query[key] != null && !scalar(query[key])) return fail(400, 'invalid_request', `Invalid ${key}`)
      const filter = { ...numeric, ...(query.titleCode ? { titleCode: query.titleCode as string } : {}), ...(query.type ? { type: query.type as typeof types[number] } : {}), ...(query.status ? { status: query.status as typeof statuses[number] } : {}) }
      const rows = listRecordCorrespondences(db, filter as CorrespondenceFilter).filter(r => (!query.role || r.role === query.role) && (!query.ruleVersion || r.ruleVersion === query.ruleVersion))
      const result = paginate(rows, paging)
      return ok({ ...result, rows: result.rows.map(r => detail(db, r)) })
    }
    if (input.action === 'candidates') {
      const parsed = candidate.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error))
      const result = generateCandidates(db, parsed.data)
      return result ? ok(result) : fail(404, 'not_found', 'Official event or enterprise not found')
    }
    if (input.action === 'preflight') {
      const parsed = decision.safeParse(input.body)
      return parsed.success ? ok(preflightRecordCorrespondences(db, parsed.data)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'commit') {
      const parsed = z.strictObject({ request: decision, planHash: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(input.body)
      return parsed.success ? ok(commitRecordCorrespondences(db, parsed.data.request, parsed.data.planHash)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'batch') {
      const key = scalar(input.key); if (!key) return fail(400, 'invalid_request', 'Idempotency key required')
      const receipt = readRecordCorrespondenceBatch(db, key)
      return receipt ? ok(receipt) : fail(404, 'not_found', 'Committed receipt not found')
    }
    const id = int(input.id); if (!id) return fail(400, 'invalid_request', 'Positive ID required')
    if (input.action === 'source') {
      if (!sourceKinds.includes(input.kind as SourceKind)) return fail(400, 'invalid_request', 'Invalid source kind')
      const source = readSource(db, input.kind as SourceKind, id)
      return source ? ok({ source, correspondences: listRecordCorrespondences(db, input.kind === 'event' ? {} : input.kind === 'relation' ? { relationId: id } : { exportRowId: id }).filter(r => input.kind !== 'event' || r.eventId === id || r.predecessorEventId === id).map(r => detail(db, r)) }) : fail(404, 'not_found', 'Source row not found')
    }
    const row = listRecordCorrespondences(db).find(r => r.id === id)
    if (!row) return fail(404, 'not_found', 'Correspondence not found')
    if (input.action === 'get') return ok(detail(db, row))
    const paging = page(input.query ?? {}); if (!paging || !permitted(input.query ?? {}, ['page', 'pageSize'])) return fail(400, 'invalid_request', 'Invalid audit query')
    return ok(paginate(audit(db, id), paging))
  } catch (error) {
    if (error instanceof CorrespondenceError) return fail(error.status, error.code, error.message)
    throw error
  }
}
