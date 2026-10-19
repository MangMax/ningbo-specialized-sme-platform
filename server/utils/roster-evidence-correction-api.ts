import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { authorizeRosterWrite } from './roster-import-http'
import { EvidenceCorrectionError, evidenceCorrectionRequestSchema, preflightEvidenceCorrection, readExactEvidence, commitEvidenceCorrection, readEvidenceCorrectionBatch, readEvidenceCorrectionAudit } from './roster-evidence-correction'
export type EvidenceCorrectionAction = 'get' | 'preflight' | 'commit' | 'audit' | 'batch'
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
export async function handleEvidenceCorrectionRequest(input: { action: EvidenceCorrectionAction; method: string; headers?: Record<string, string | undefined>; body?: unknown; id?: unknown; key?: unknown; query?: Record<string, unknown> }, context: { db: BetterSQLite3Database<typeof schema>; apiToken?: string | null; filesDir?: string }) {
  const error = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
  const ok = (body: unknown) => ({ status: 200, headers, body })
  const write = ['preflight', 'commit', 'batch'].includes(input.action)
  if (input.method !== (['preflight', 'commit'].includes(input.action) ? 'POST' : 'GET')) return error(405, 'method_not_allowed', 'Method not allowed')
  if (write && !authorizeRosterWrite({ headers: input.headers ?? {} }, context.apiToken).ok) return error(401, 'unauthorized', 'Configured token required')
  try {
    if (input.action === 'preflight') {
      const parsed = evidenceCorrectionRequestSchema.safeParse(input.body)
      if (!parsed.success) return error(400, 'invalid_request', 'Provide exact evidence/event/owner IDs, version, full coordinate, actor and basis; maximum 100 operations')
      return ok(await preflightEvidenceCorrection(context.db, parsed.data, context.filesDir))
    }
    if (input.action === 'commit') {
      const parsed = z.strictObject({ request: evidenceCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(input.body)
      if (!parsed.success) return error(400, 'invalid_request', 'Request and preflight planHash required')
      return ok(await commitEvidenceCorrection(context.db, parsed.data.request, parsed.data.planHash, context.filesDir))
    }
    if (input.action === 'batch') {
      if (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 200) return error(400, 'invalid_request', 'Idempotency key required')
      const batch = readEvidenceCorrectionBatch(context.db, input.key)
      return batch ? ok(batch) : error(404, 'not_found', 'Receipt not found')
    }
    const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(input.id)
    if (!id.success) return error(400, 'invalid_request', 'Positive evidence ID required')
    if (input.action === 'audit') {
      const paging = z.strictObject({ page: z.coerce.number().int().positive().max(1000000).default(1), pageSize: z.coerce.number().int().positive().max(200).default(50) }).safeParse(input.query ?? {})
      if (!paging.success) return error(400, 'invalid_request', 'Invalid audit pagination')
      return ok(context.db.transaction(tx => readEvidenceCorrectionAudit(tx, id.data, paging.data.page, paging.data.pageSize)))
    }
    if (input.action === 'get') return ok(context.db.transaction(tx => readExactEvidence(tx, id.data)))
    return error(404, 'not_found', 'Operation unavailable')
  } catch (caught) {
    if (caught instanceof Error && (caught as { code?: string }).code === 'stale_revision') return error(409, 'stale_revision', 'Official event revision changed')
    if (caught instanceof EvidenceCorrectionError) return error(caught.status, caught.code, caught.message)
    return error(500, 'internal_error', 'Evidence correction failed')
  }
}
