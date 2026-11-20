import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import * as schema from '../../../../db/schema'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { importPostgresReceiptRedactor } from './import-receipt-redaction'
import { sanitizeEvidence } from './record-correspondence-read'
import { readPostgresCorrectionAudit, readPostgresExactEvidence, readPostgresOfficialEvent, readPostgresPublicOfficialEvidence } from './official-evidence-postgres'
import { evidenceReadSchema, eventReadSchema, officialReadQuery } from './official-evidence-read'
import { usePostgresRosterDb } from './postgres-roster-db'

const headers = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }
const failure = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
const ok = (body: object) => ({ status: 200, headers, body })
const integer = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
type Input = {
  kind: 'event' | 'evidence'
  action: 'get' | 'audit' | 'batch'
  method: string
  query?: Record<string, unknown>
  id?: unknown
  key?: unknown
  headers?: Record<string, string | undefined>
}
type Context = { db: NodePgDatabase; apiToken?: string | null }

export async function handlePostgresOfficialEvidenceRead(input: Input, context: Context) {
  const event = input.kind === 'event'
  const query = input.query ?? {}
  const official = 'official' in query
  if (input.method !== 'GET') return failure(405, 'method_not_allowed', 'Method not allowed')
  const authorized = resolveApiAuth({ given: readApiToken(input.headers), configured: context.apiToken }).writeAuthorized
  if ((input.action === 'batch' || input.action === 'get' && official) && !authorized) {
    return failure(401, 'unauthorized', event ? 'Configured API token required' : 'Configured token required')
  }
  try {
    if (input.action === 'batch') {
      const { key } = input
      if (typeof key !== 'string' || !key.trim() || key.length > 200) return failure(400, 'invalid_request', 'Idempotency key required')
      if (key.includes('\0') || !key.isWellFormed()) return failure(404, 'not_found', 'Receipt not found')
      const { rows: [row] } = await context.db.execute<{ receipt: object }>(sql`
        SELECT receipt::json AS receipt FROM evidence_correction_batch WHERE idempotency_key = ${key}`)
      return row ? ok(row.receipt) : failure(404, 'not_found', 'Receipt not found')
    }
    const id = integer.safeParse(input.id)
    if (!id.success) return failure(400, 'invalid_request', event ? 'Positive event ID required' : 'Positive evidence ID required')
    const value = id.data
    return await context.db.transaction(async tx => {
      if (input.action === 'audit') {
        const paging = z.strictObject({
          page: (event ? integer : integer.max(1_000_000)).default(1),
          pageSize: integer.max(event ? 100 : 200).default(50),
        }).safeParse(query)
        if (!paging.success || (paging.data.page - 1) * paging.data.pageSize > Number.MAX_SAFE_INTEGER) {
          return failure(400, 'invalid_request', event ? 'Invalid bounded audit pagination' : 'Invalid audit pagination')
        }
        const { page, pageSize } = paging.data
        if (!event) {
          await readPostgresExactEvidence(tx, value)
          return ok(await readPostgresCorrectionAudit(tx, schema.evidenceCorrectionAudit,
            sql`FROM evidence_correction_audit p WHERE p.evidence_id = ${value}`, page, pageSize))
        }
        const { rowCount } = await tx.execute(sql`SELECT 1 FROM record_event e JOIN record r ON r.id = e.record_id
          WHERE e.id = ${value} AND r.source = 'jxj'`)
        if (!rowCount) return failure(404, 'not_found', 'Official event not found')
        const result = await readPostgresCorrectionAudit(tx, schema.eventCorrectionAudit,
          sql`FROM event_correction_audit p WHERE p.event_id = ${value}`, page, pageSize)
        const redact = await importPostgresReceiptRedactor(tx, { additionalSecrets: [context.apiToken] })
        return ok(sanitizeEvidence(result, redact.knownRedactors) as typeof result)
      }
      if (event) {
        const parsed = eventReadSchema.safeParse(officialReadQuery({ ...query, eventId: value }))
        if (Object.keys(query).length && (!parsed.success || !parsed.data.official)) return failure(400, 'invalid_request', 'Invalid bounded official event query')
        const redact = await importPostgresReceiptRedactor(tx, { additionalSecrets: [context.apiToken] })
        const result = sanitizeEvidence(await readPostgresOfficialEvent(tx, value), redact.knownRedactors) as object
        return ok(parsed.success && parsed.data.official
          ? { ...result, official: await readPostgresPublicOfficialEvidence(tx, input.kind, parsed.data) }
          : result)
      }
      if (!official) return ok(await readPostgresExactEvidence(tx, value))
      const parsed = evidenceReadSchema.safeParse(officialReadQuery({ ...query, id: value }))
      if (!parsed.success || !parsed.data.official) return failure(400, 'invalid_query', 'Invalid bounded official evidence query')
      const result = await readPostgresExactEvidence(tx, value)
      return ok({ ...result, official: await readPostgresPublicOfficialEvidence(tx, input.kind, parsed.data) })
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  } catch (error) {
    const cause = error as { statusCode?: number; code?: string; message?: string }
    if (cause.statusCode && cause.code) return failure(cause.statusCode, cause.code, cause.message ?? 'Official evidence read failed')
    return event ? failure(500, 'transaction_failed', 'Event correction failed; no partial changes committed')
      : failure(500, 'internal_error', 'Evidence correction failed')
  }
}

export async function dispatchPostgresOfficialEvidenceMcp(
  kind: Input['kind'], action: Input['action'], args: Record<string, unknown>, authorized = false,
) {
  const db = usePostgresRosterDb()
  if (!db) return undefined
  const idKey = kind === 'event' ? 'eventId' : 'id'
  const query = Object.fromEntries(Object.entries(args).filter(([key, value]) =>
    value !== undefined && key !== idKey && (action === 'get' || action === 'audit' && ['page', 'pageSize'].includes(key))))
  const output = await handlePostgresOfficialEvidenceRead({
    kind, action, method: 'GET', query, id: args[idKey], key: args.idempotencyKey,
    headers: authorized ? { authorization: 'Bearer mcp-official-read' } : undefined,
  }, { db, apiToken: 'mcp-official-read' })
  if (output.status !== 200) {
    const { error } = output.body as { error: { code: string; message: string } }
    throw Object.assign(new Error(args.official !== undefined ? JSON.stringify(output.body) : error.message),
      { code: error.code, statusCode: output.status })
  }
  return output.body
}
