import { z } from 'zod'
import { authorizeRosterWrite } from './roster-import-http'
import { OfficialEvidenceError } from './official-evidence'
import { EvidenceCorrectionError, evidenceCorrectionRequestSchema } from './roster-evidence-correction-model'
import { commitPostgresEvidenceCorrection, preflightPostgresEvidenceCorrection } from './roster-evidence-correction-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
type Input = { action: 'preflight' | 'commit'; method: string; headers?: Record<string, string | undefined>; body?: unknown }
type Context = { apiToken?: string | null; filesDir?: string }
export async function handlePostgresEvidenceCorrectionWrite(input: Input, context: Context) {
  const error = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
  const ok = (body: object) => ({ status: 200, headers, body: { ...body } })
  if (input.method !== 'POST') return error(405, 'method_not_allowed', 'Method not allowed')
  if (!authorizeRosterWrite({ headers: input.headers ?? {} }, context.apiToken).ok) return error(401, 'unauthorized', 'Configured token required')
  try {
    if (input.action === 'preflight') {
      const parsed = evidenceCorrectionRequestSchema.safeParse(input.body)
      if (!parsed.success) return error(400, 'invalid_request', 'Provide exact evidence/event/owner IDs, version, full coordinate, actor and basis; maximum 100 operations')
      const db = usePostgresRosterDb(true)
      return ok(await preflightPostgresEvidenceCorrection(db, parsed.data, context.filesDir))
    }
    if (input.action === 'commit') {
      const parsed = z.strictObject({ request: evidenceCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(input.body)
      if (!parsed.success) return error(400, 'invalid_request', 'Request and preflight planHash required')
      const db = usePostgresRosterDb(true)
      return ok(await commitPostgresEvidenceCorrection(db, parsed.data.request, parsed.data.planHash, context.filesDir))
    }
    return error(404, 'not_found', 'Operation unavailable')
  } catch (caught) {
    if (caught instanceof Error && (caught as { code?: string }).code === 'stale_revision') return error(409, 'stale_revision', 'Official event revision changed')
    if (caught instanceof OfficialEvidenceError) return error(caught.statusCode,caught.code,caught.message)
    if ((caught as { statusCode?: number })?.statusCode === 503) return error(503, 'unavailable', 'Writable evidence database unavailable')
    if (caught instanceof EvidenceCorrectionError) return error(caught.status, caught.code, caught.message)
    return error(500, 'internal_error', 'Evidence correction failed')
  }
}
