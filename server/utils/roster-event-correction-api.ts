import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { readApiToken, resolveApiAuth } from './api-auth'
import { sanitizeEvidence } from './record-correspondence-read'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveCredential } from './credential-state'
import { commitEventCorrections, eventCorrectionRequestSchema, preflightEventCorrections, readEventCorrectionAudit, readOfficialEvent } from './roster-event-correction'

export type EventCorrectionAction = 'get' | 'audit' | 'preflight' | 'commit'
const integer = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export function handleEventCorrectionRequest(input: { action: EventCorrectionAction; method: string; id?: unknown; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string | undefined> }, context: { db: BetterSQLite3Database<typeof schema>; apiToken?: string | null }) {
  const headers = { 'cache-control': 'no-store' }
  const fail = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
  const write = input.action === 'preflight' || input.action === 'commit'
  if (write && !resolveApiAuth({ given: readApiToken(input.headers), configured: context.apiToken }).writeAuthorized) return fail(401, 'unauthorized', 'Configured API token required')
  if (input.method !== (write ? 'POST' : 'GET')) return fail(405, 'method_not_allowed', 'Method not allowed')
  try {
    // Resolve before mutations; never let credential lookup fail after commit.
    const credentials = { ...credentialContext(), db: context.db }
    const runtime = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : null
    const secrets = [context.apiToken, runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN, resolveCredential('miitCookie', credentials).value, resolveCredential('ocrToken', credentials).value].filter((s): s is string => !!s)
    const redactors = [...new Set(secrets)].map(cookieRedactor)
    let result: unknown
    if (write) {
      if (Buffer.byteLength(JSON.stringify(input.body) ?? '', 'utf8') > 1024 * 1024) return fail(413, 'request_limit', 'Event correction request exceeds 1 MiB')
      if (input.action === 'preflight') {
        const parsed = eventCorrectionRequestSchema.safeParse(input.body)
        if (!parsed.success) return fail(400, 'invalid_request', 'Invalid event correction request; use the documented strict whitelist')
        result = preflightEventCorrections(context.db, parsed.data)
      } else {
        const parsed = z.strictObject({ request: eventCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(input.body)
        if (!parsed.success) return fail(400, 'invalid_request', 'Original correction request and planHash required')
        result = commitEventCorrections(context.db, parsed.data.request, parsed.data.planHash)
      }
    } else {
      const id = integer.safeParse(input.id)
      if (!id.success) return fail(400, 'invalid_request', 'Positive event ID required')
      if (input.action === 'audit') {
        const paging = z.strictObject({ page: integer.default(1), pageSize: integer.max(100).default(50) }).safeParse(input.query ?? {})
        if (!paging.success || (paging.data.page - 1) * paging.data.pageSize > Number.MAX_SAFE_INTEGER) return fail(400, 'invalid_request', 'Invalid bounded audit pagination')
        result = readEventCorrectionAudit(context.db, id.data, paging.data.page, paging.data.pageSize)
      } else {
        if (Object.keys(input.query ?? {}).length) return fail(400, 'invalid_request', 'Exact event read takes no query fields')
        result = readOfficialEvent(context.db, id.data)
      }
    }
    return { status: 200, headers, body: sanitizeEvidence(result, redactors) }
  } catch (error) {
    const known = error as { statusCode?: number; code?: string; message?: string }
    if (known.statusCode && known.code) return fail(known.statusCode, known.code, known.message ?? 'Correction rejected')
    // SQL/trigger failures reveal no raw SQL, credentials or request data; transaction already rolled back.
    return fail(500, 'transaction_failed', 'Event correction failed; no partial changes committed')
  }
}
