import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { eventReadSchema, officialReadQuery, readPublicOfficialEvidence } from './official-evidence-read'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { sanitizeEvidence } from './record-correspondence-read'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from '../../../core/server/utils/credential-state'
import { eventCorrectionFailure, commitEventCorrections, eventCorrectionRequestSchema, finalizedCorrectionReadback, preflightEventCorrections, readEventCorrectionAudit, readOfficialEvent } from './roster-event-correction'

export type EventCorrectionAction = 'get' | 'audit' | 'preflight' | 'commit'
const integer = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const commitSchema = z.strictObject({ request: eventCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) })

export function parseEventCorrectionWrite(action: 'preflight' | 'commit', body: unknown) {
  if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') > 1024 * 1024) return eventCorrectionFailure(413, 'request_limit', 'Event correction request exceeds 1 MiB')
  if (action === 'preflight') {
    const parsed = eventCorrectionRequestSchema.safeParse(body)
    if (!parsed.success) return eventCorrectionFailure(400, 'invalid_request', 'Invalid event correction request; use the documented strict whitelist')
    return { request: parsed.data, planHash: null }
  }
  const parsed = commitSchema.safeParse(body)
  if (!parsed.success) return eventCorrectionFailure(400, 'invalid_request', 'Original correction request and planHash required')
  return parsed.data
}

export function eventCorrectionOutput(result: unknown, safety: Parameters<typeof finalizedCorrectionReadback>[1], redactors: ReadonlyArray<(text: string) => string>) {
  const finalized = finalizedCorrectionReadback(result, safety)
  if (!finalized) return sanitizeEvidence(result, redactors)
  const legacy = sanitizeEvidence(finalized.legacy, redactors)
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('Invalid sanitized correction result')
  return { ...legacy, qualificationReadback: finalized.value }
}

export function eventCorrectionError(error: unknown) {
  const known = error as { statusCode?: number; code?: string; message?: string }
  return known.statusCode && known.code
    ? { status: known.statusCode, code: known.code, message: known.message ?? 'Correction rejected' }
    : { status: 500, code: 'transaction_failed', message: 'Event correction failed; no partial changes committed' }
}

export function handleEventCorrectionRequest(input: { action: EventCorrectionAction; method: string; id?: unknown; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string | undefined> }, context: { db: BetterSQLite3Database<typeof schema>; apiToken?: string | null }) {
  const headers = { 'cache-control': 'no-store' }
  const fail = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
  const write = input.action === 'preflight' || input.action === 'commit'
  if (write && !resolveApiAuth({ given: readApiToken(input.headers), configured: context.apiToken }).writeAuthorized) return fail(401, 'unauthorized', 'Configured API token required')
  if (input.method !== (write ? 'POST' : 'GET')) return fail(405, 'method_not_allowed', 'Method not allowed')
  if(input.action==='get' && input.query && 'official' in input.query && !resolveApiAuth({given:readApiToken(input.headers),configured:context.apiToken}).writeAuthorized) return fail(401,'unauthorized','Configured API token required')
  try {
    // Resolve before mutations; never let credential lookup fail after commit.
    const credentials = { ...credentialContext(), db: context.db }
    const runtime = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : null
    const secrets = [context.apiToken, runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN, resolveCredential('sme-roster.miitCookie', credentials).value, resolveCredential('core.ocrToken', credentials).value].filter((s): s is string => !!s)
    const redactors = [...new Set(secrets)].map(cookieRedactor)
    const qualificationSafety = (value: unknown) => isDeepStrictEqual(value, sanitizeEvidence(value, redactors))
    let result: unknown
    if (write) {
      const command = parseEventCorrectionWrite(input.action as 'preflight' | 'commit', input.body)
      result = command.planHash === null ? preflightEventCorrections(context.db, command.request, qualificationSafety)
        : commitEventCorrections(context.db, command.request, command.planHash, qualificationSafety)
    } else {
      const id = integer.safeParse(input.id)
      if (!id.success) return fail(400, 'invalid_request', 'Positive event ID required')
      if (input.action === 'audit') {
        const paging = z.strictObject({ page: integer.default(1), pageSize: integer.max(100).default(50) }).safeParse(input.query ?? {})
        if (!paging.success || (paging.data.page - 1) * paging.data.pageSize > Number.MAX_SAFE_INTEGER) return fail(400, 'invalid_request', 'Invalid bounded audit pagination')
        result = readEventCorrectionAudit(context.db, id.data, paging.data.page, paging.data.pageSize)
      } else {
        if (Object.keys(input.query ?? {}).length) {
          const parsed=eventReadSchema.safeParse(officialReadQuery({...input.query,eventId:id.data}))
          if(!parsed.success || !parsed.data.official) return fail(400,'invalid_request','Invalid bounded official event query')
          result=context.db.transaction(()=>({...sanitizeEvidence(readOfficialEvent(context.db,id.data),redactors) as object,official:readPublicOfficialEvidence(context.db,'event',parsed.data)}))
        } else result = readOfficialEvent(context.db, id.data)
      }
    }
    // The opt-in branch already sanitizes legacy fields and independently budgets the
    // redacted official envelope. A second pass can expand it after that final gate.
    if (input.action==='get' && input.query && 'official' in input.query) return { status: 200, headers, body: result }
    return { status: 200, headers, body: eventCorrectionOutput(result, qualificationSafety, redactors) }
  } catch (error) {
    const rejection = eventCorrectionError(error)
    return fail(rejection.status, rejection.code, rejection.message)
  }
}
