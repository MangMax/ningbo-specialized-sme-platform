import { parseEventCorrectionWrite, eventCorrectionOutput, eventCorrectionError } from './roster-event-correction-http-model'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { eventReadSchema, officialReadQuery } from './official-evidence-read'
import { readPublicOfficialEvidence } from './official-evidence-read-sqlite'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { sanitizeEvidence } from './evidence-redaction'
import { cookieRedactor } from '../../lib/platform/client'
import { credentialContext, resolveFromState } from '../../../core/server/utils/credential-resolution'
import { readRosterFixtureCredentials } from './roster-fixture-credentials'
import { commitEventCorrections, preflightEventCorrections, readEventCorrectionAudit, readOfficialEvent } from './roster-event-correction'
export type EventCorrectionAction = 'get' | 'audit' | 'preflight' | 'commit'
const integer = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export function handleEventCorrectionRequest(input: { action: EventCorrectionAction; method: string; id?: unknown; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string | undefined> }, context: { db: BetterSQLite3Database<typeof schema>; apiToken?: string | null }) {
  const headers = { 'cache-control': 'no-store' }
  const fail = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
  const write = input.action === 'preflight' || input.action === 'commit'
  if (write && !resolveApiAuth({ given: readApiToken(input.headers), configured: context.apiToken }).writeAuthorized) return fail(401, 'unauthorized', 'Configured API token required')
  if (input.method !== (write ? 'POST' : 'GET')) return fail(405, 'method_not_allowed', 'Method not allowed')
  if(input.action==='get' && input.query && 'official' in input.query && !resolveApiAuth({given:readApiToken(input.headers),configured:context.apiToken}).writeAuthorized) return fail(401,'unauthorized','Configured API token required')
  try {
    // Resolve before mutations; never let credential lookup fail after commit.
    const credentials = credentialContext()
    const saved = readRosterFixtureCredentials(context.db)
    const runtime = typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : null
    const secrets = [context.apiToken, runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN, resolveFromState('sme-roster.miitCookie', credentials, saved).value, resolveFromState('core.ocrToken', credentials, saved).value].filter((s): s is string => !!s)
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
export { parseEventCorrectionWrite, eventCorrectionOutput, eventCorrectionError } from './roster-event-correction-http-model'
