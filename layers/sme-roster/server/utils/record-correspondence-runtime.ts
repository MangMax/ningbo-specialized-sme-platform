import { and, count, eq, getTableColumns, sql } from 'drizzle-orm'
import { listPostgresCorrespondences, pagePostgresCorrespondences, readPostgresCorrespondenceSources } from './record-correspondence-postgres'
import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from './record-correspondence-write-postgres'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { recordCorrespondence, recordCorrespondenceAudit } from '../../../../db/postgresql/qualification-tables'
import { z } from 'zod'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { usePostgresRosterDb } from './postgres-roster-db'
import { type CorrespondenceFilter, type CorrespondenceRead } from './record-correspondence'
import { CorrespondenceError } from './record-correspondence-model'
import { sanitizeEvidence } from './evidence-redaction'
import type { SourceKind, projectCorrespondenceSources } from './record-correspondence-projection'
import { summaries } from './record-correspondence-summary-projection'
import { discoverPostgresEventArchives, generatePostgresCandidates } from './record-correspondence-candidates-postgres'

export type CorrespondenceAction = 'discover' | 'list' | 'get' | 'audit' | 'source' | 'candidates' | 'preflight' | 'commit' | 'batch'

export interface CorrespondenceApiInput { action: CorrespondenceAction; method: string; query?: Record<string, unknown>; body?: unknown; id?: unknown; kind?: unknown; key?: unknown; headers?: Record<string, string | undefined> }

export interface CorrespondenceApiOutput { status: number; headers: Record<string, string>; body: Record<string, unknown> }

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

export const decision = z.strictObject({ idempotencyKey: z.string().trim().min(1), sourceIdentity: z.string().trim().min(1), actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1) }), basis: z.string().trim().min(1), ruleId: z.string().trim().min(1), ruleVersion: z.string().trim().min(1), operations: z.array(operation).min(1) })

export const commitDecision = z.strictObject({ request: decision, planHash: z.string().regex(/^[0-9a-f]{64}$/) })

export const candidate = z.strictObject({ eventId: positive.optional(), enterpriseId: positive.optional(), titleCode: z.string().min(1).optional(), queryIds: z.array(positive).default([]), exportBatchIds: z.array(positive).default([]), ruleVersion: z.string().trim().min(1), page: positive.default(1), pageSize: positive.max(200).default(50) }).refine(v => v.eventId ? !v.enterpriseId && !v.titleCode : !!v.enterpriseId && !!v.titleCode, 'Provide eventId or enterpriseId and titleCode').refine(v => v.queryIds.length + v.exportBatchIds.length > 0, 'Specify archived query or export batch IDs')

export const discovery = z.strictObject({ eventId: positive, page: positive.default(1), pageSize: positive.max(200).default(50),
  queryPage: positive.default(1), queryPageSize: positive.max(200).default(25) })

export const sourceKinds = ['event', 'relation', 'export_row'] as const

function fail(status: number, code: string, message: string): CorrespondenceApiOutput { return { status, headers, body: { error: { code, message } } } }

function success(body: object): CorrespondenceApiOutput { return { status: 200, headers, body: { ...body } } }

export function ok(body: object, redactors: ReadonlyArray<(text: string) => string>): CorrespondenceApiOutput { return success(sanitizeEvidence({ ...body }, redactors)) }

type CorrespondenceSourceReader = ReturnType<typeof projectCorrespondenceSources>
type CorrespondenceDetail = ReturnType<CorrespondenceSourceReader['detail']>
type PublishedEvent = NonNullable<CorrespondenceDetail['event']>

/** Visit this already-hydrated object's own fields in their original order.
 * Only a trusted event/evidence seam may identify its additive finalized slot. */
export function sanitizePublishedObject(value: object, redactors: ReadonlyArray<(text: string) => string>, visit: (key: string, item: unknown) => unknown, finalizedKey?: 'publishedPresentation' | 'publishedName') {
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
export function sanitizePublishedEvent(event: PublishedEvent | null, redactors: ReadonlyArray<(text: string) => string>) {
  if (!event) return null
  return sanitizePublishedObject(event, redactors, (key, value) => {
    if (key === 'evidence') return event.evidence.map(item => sanitizePublishedEvidenceItem(item, redactors))
    if (key === 'officialEvidence') return event.officialEvidence.map(item => sanitizePublishedEvidenceItem(item, redactors))
    return sanitizeEvidence(value, redactors)
  }, 'publishedPresentation')
}

export function sanitizePublishedDetail(row: CorrespondenceDetail, redactors: ReadonlyArray<(text: string) => string>) {
  return sanitizePublishedObject(row, redactors, (key, value) => {
    if (key === 'event') return sanitizePublishedEvent(row.event, redactors)
    if (key === 'predecessorEvent') return sanitizePublishedEvent(row.predecessorEvent, redactors)
    return sanitizeEvidence(value, redactors)
  })
}

export function int(value: unknown) { const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null }

function page(query: Record<string, unknown>) { const p = query.page == null ? 1 : int(query.page); const s = query.pageSize == null ? 50 : int(query.pageSize); return p && s && s <= 200 ? { page: p, pageSize: s } : null }

export function scalar(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : null }

function ids(input: Record<string, unknown>, keys: string[]) { const result: Record<string, number> = {}; for (const key of keys) if (input[key] != null) { const value = int(input[key]); if (!value) return null; result[key] = value } return result }

function permitted(input: Record<string, unknown>, keys: string[]) { return Object.keys(input).every(key => keys.includes(key)) }

export function auth(input: CorrespondenceApiInput, configured: string | null | undefined) { return resolveApiAuth({ given: readApiToken(input.headers), configured }).writeAuthorized }

export function auditPaging(query: Record<string, unknown>) {
  return permitted(query, ['page', 'pageSize']) ? page(query) : null
}

export function auditResponse<T extends { rows: { evidence: unknown }[] }>(result: T, redactors: ReadonlyArray<(text: string) => string>) {
  return ok({ ...result, rows: result.rows.map(({ evidence, ...row }) => ({ ...row, evidence: sanitizeEvidence(evidence) })) }, redactors)
}

export function batchResponse(receipt: object | null | undefined, redactors: ReadonlyArray<(text: string) => string>) {
  return receipt ? ok(receipt, redactors) : fail(404, 'not_found', 'Committed receipt not found')
}

export function detailPageResponse(page: object, rows: CorrespondenceDetail[], redactors: ReadonlyArray<(text: string) => string>) {
  const body = { ...page, rows }
  return success(sanitizePublishedObject(body, redactors, (key, value) => key === 'rows'
    ? rows.map(row => sanitizePublishedDetail(row, redactors)) : sanitizeEvidence(value, redactors)))
}

export function sourceFilter(kind: SourceKind, id: number): CorrespondenceFilter {
  return kind === 'event' ? { anyEventId: id } : kind === 'relation' ? { relationId: id } : { exportRowId: id }
}

export function sourceResponse(reader: CorrespondenceSourceReader, kind: SourceKind, id: number, rows: CorrespondenceRead[], redactors: ReadonlyArray<(text: string) => string>) {
  const source = reader.read(kind, id)
  if (!source) return fail(404, 'not_found', 'Source row not found')
  const body = { source, correspondences: rows.map(reader.detail) }
  return success(sanitizePublishedObject(body, redactors, (key, value) => {
    if (key === 'source' && kind === 'event') return sanitizePublishedEvent(source as PublishedEvent, redactors)
    if (key === 'correspondences') return body.correspondences.map(row => sanitizePublishedDetail(row, redactors))
    return sanitizeEvidence(value, redactors)
  }))
}

export function parseListQuery(query: Record<string, unknown>) {
  const paging = page(query)
  const keys = ['eventId', 'relationId', 'exportRowId', 'enterpriseId', 'titleCode', 'type', 'role', 'status', 'ruleVersion', 'page', 'pageSize', 'view']
  if (!paging || !permitted(query, keys)) return fail(400, 'invalid_request', 'Invalid list query')
  if (query.view != null && query.view !== 'summary') return fail(400, 'invalid_request', 'Invalid view')
  const numeric = ids(query, ['eventId', 'relationId', 'exportRowId', 'enterpriseId']); if (!numeric) return fail(400, 'invalid_request', 'Invalid source ID')
  const types = ['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export']
  const statuses = ['candidate', 'confirmed', 'rejected', 'unlinked']
  if (query.type != null && !types.includes(query.type as string) || query.status != null && !statuses.includes(query.status as string)) return fail(400, 'invalid_request', 'Invalid type or status')
  for (const key of ['titleCode', 'role', 'ruleVersion']) if (query[key] != null && !scalar(query[key])) return fail(400, 'invalid_request', `Invalid ${key}`)
  const filter = { ...numeric, ...(query.titleCode ? { titleCode: query.titleCode as string } : {}), ...(query.type ? { type: query.type as typeof types[number] } : {}), ...(query.status ? { status: query.status as typeof statuses[number] } : {}), ...(query.role ? { role: query.role as string } : {}), ...(query.ruleVersion ? { ruleVersion: query.ruleVersion as string } : {}) }
  return { filter: filter as CorrespondenceFilter, paging, view: query.view }
}

export async function handlePostgresCorrespondenceRequest(input: CorrespondenceApiInput, apiToken?: string | null, browserAuthorized = false): Promise<CorrespondenceApiOutput> {
  const write = input.action === 'preflight' || input.action === 'commit'
  const method = ['list', 'get', 'audit', 'source', 'batch'].includes(input.action) ? 'GET' : 'POST'
  const db = usePostgresRosterDb()
  if ((write || input.action === 'batch') && !browserAuthorized && !auth(input, apiToken)) return fail(401, 'unauthorized', 'Configured API token required')
  if (input.method !== method) return fail(405, 'method_not_allowed', `${method} required`)
  if (write) {
    const writable = usePostgresRosterDb(true)
    try {
      const { knownRedactors } = await importPostgresReceiptRedactor(db, { additionalSecrets: [apiToken] })
      if (input.action === 'preflight') {
        const parsed = decision.safeParse(input.body)
        return parsed.success ? ok(await preflightPostgresCorrespondences(writable, parsed.data), knownRedactors)
          : fail(400, 'invalid_request', z.prettifyError(parsed.error))
      }
      const parsed = commitDecision.safeParse(input.body)
      return parsed.success ? ok(await commitPostgresCorrespondences(writable, parsed.data.request, parsed.data.planHash), knownRedactors)
        : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    } catch (error) {
      if (error instanceof CorrespondenceError) return fail(error.status, error.code, error.message)
      throw error
    }
  }
  return db.transaction(async tx => {
    const redact = await importPostgresReceiptRedactor(tx, { additionalSecrets: [apiToken] })
    const { knownRedactors } = redact
    if (input.action === 'candidates') {
      const parsed = candidate.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error))
      const result = await generatePostgresCandidates(tx, parsed.data)
      return result ? ok(result, knownRedactors) : fail(404, 'not_found', 'Official event or enterprise not found')
    }
    if (input.action === 'discover') {
      const parsed = discovery.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', 'Invalid event discovery request')
      const result = await discoverPostgresEventArchives(tx, parsed.data, redact)
      if (!result) return fail(404, 'not_found', 'Official award or review event not found')
      return success(sanitizePublishedObject(result, knownRedactors, (key, value) => key === 'event'
        ? sanitizePublishedEvent(result.event, knownRedactors) : sanitizeEvidence(value, knownRedactors)))
    }
    if (input.action === 'list') {
      const parsed = parseListQuery(input.query ?? {})
      if ('status' in parsed) return parsed
      const result = await pagePostgresCorrespondences(tx, parsed.filter, parsed.paging)
      if (parsed.view === 'summary') return ok({ ...result, rows: summaries(result.rows) }, knownRedactors)
      const reader = await readPostgresCorrespondenceSources(tx, result.rows, redact)
      return detailPageResponse(result, result.rows.map(reader.detail), knownRedactors)
    }
    if (input.action === 'batch') {
      const key = scalar(input.key)
      if (!key) return fail(400, 'invalid_request', 'Idempotency key required')
      const b = importBatch
      const [batch] = await tx.select({ receipt: sql<object | null>`${b.summary}::json` }).from(b)
        .where(and(eq(b.idempotencyKey, key), eq(b.sourceKind, 'correspondence_decision'), eq(b.status, 'committed')))
      return batchResponse(batch?.receipt, knownRedactors)
    }
    const id = int(input.id)
    if (!id) return fail(400, 'invalid_request', 'Positive ID required')
    if (input.action === 'source') {
      const kind = input.kind as SourceKind
      if (!sourceKinds.includes(kind)) return fail(400, 'invalid_request', 'Invalid source kind')
      const rows = await listPostgresCorrespondences(tx, sourceFilter(kind, id))
      const reader = await readPostgresCorrespondenceSources(tx, rows, redact, { kind, id })
      return sourceResponse(reader, kind, id, rows, knownRedactors)
    }
    if (input.action === 'get') {
      const rows = await listPostgresCorrespondences(tx, { id })
      if (!rows.length) return fail(404, 'not_found', 'Correspondence not found')
      const reader = await readPostgresCorrespondenceSources(tx, rows, redact)
      return success(sanitizePublishedDetail(reader.detail(rows[0]!), knownRedactors))
    }
    const edge = recordCorrespondence
    const [match] = await tx.select({ id: edge.id }).from(edge).where(eq(edge.id, id))
    if (!match) return fail(404, 'not_found', 'Correspondence not found')
    const paging = auditPaging(input.query ?? {})
    if (!paging) return fail(400, 'invalid_request', 'Invalid audit query')
    const a = recordCorrespondenceAudit
    const fields = getTableColumns(a)
    const where = eq(a.correspondenceId, id)
    const [total] = await tx.select({ n: count() }).from(a).where(where)
    const stored = await tx.select(fields).from(a).where(where).orderBy(a.id).limit(paging.pageSize)
      .offset(Math.min(Number.MAX_SAFE_INTEGER, (paging.page - 1) * paging.pageSize))
    const rows = stored.map(row => ({ ...row, evidence: JSON.parse(row.evidence) as Record<string, unknown> }))
    return auditResponse({ rows, total: total!.n, ...paging }, knownRedactors)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
