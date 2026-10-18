import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { readApiToken, resolveApiAuth } from './api-auth'
import { commitComparisonScopeProofs, listComparisonScopeProofs, preflightComparisonScopeProofs, proofRequest, ProofError, readComparisonScopeProof, readComparisonScopeProofAudit, readComparisonScopeProofBatch } from './comparison-scope-proof'
import { ProofSourceError } from './comparison-scope-proof-source'

type Db = BetterSQLite3Database<typeof schema>
export type ProofAction = 'preflight' | 'commit' | 'list' | 'get' | 'audit' | 'batch'
export interface ProofApiInput { action: ProofAction; method: string; body?: unknown; query?: Record<string, unknown>; id?: unknown; key?: unknown; headers?: Record<string, string | undefined> }
const headers = { 'cache-control': 'no-store' }
const fail = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
const ok = (body: unknown) => ({ status: 200, headers, body })
const integer = (value: unknown) => { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value; return Number.isSafeInteger(n) && (n as number) > 0 ? n as number : null }
const page = (query: Record<string, unknown>) => { const p = query.page == null ? 1 : integer(query.page); const s = query.pageSize == null ? 50 : integer(query.pageSize); return p && s && s <= 200 ? { page: p, pageSize: s } : null }
const paginate = <T>(rows: T[], paging: { page: number; pageSize: number }) => ({ rows: rows.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: rows.length, ...paging })

export function handleComparisonScopeProofRequest(input: ProofApiInput, context: { db: Db; apiToken?: string | null }) {
  try {
    const write = ['preflight', 'commit', 'batch'].includes(input.action)
    if (write && !resolveApiAuth({ given: readApiToken(input.headers), configured: context.apiToken }).writeAuthorized) return fail(401, 'unauthorized', 'Configured API token required')
    const method = ['preflight', 'commit'].includes(input.action) ? 'POST' : 'GET'
    if (input.method !== method) return fail(405, 'method_not_allowed', `${method} required`)
    if (input.action === 'preflight') {
      const parsed = proofRequest.safeParse(input.body)
      return parsed.success ? ok(preflightComparisonScopeProofs(context.db, parsed.data)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'commit') {
      const parsed = z.strictObject({ request: proofRequest, planHash: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(input.body)
      return parsed.success ? ok(commitComparisonScopeProofs(context.db, parsed.data.request, parsed.data.planHash)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'batch') {
      if (typeof input.key !== 'string' || !input.key.trim()) return fail(400, 'invalid_request', 'Idempotency key required')
      const receipt = readComparisonScopeProofBatch(context.db, input.key)
      return receipt ? ok(receipt) : fail(404, 'not_found', 'Committed receipt not found')
    }
    if (input.action === 'list') {
      const query = input.query ?? {}
      const paging = page(query)
      if (!paging || Object.keys(query).some(key => !['kind', 'status', 'page', 'pageSize'].includes(key))) return fail(400, 'invalid_request', 'Invalid list query')
      const parsed = z.object({ kind: z.enum(['official_coverage', 'current_source_equivalence']).optional(), status: z.enum(['candidate', 'confirmed', 'revoked']).optional() }).safeParse(query)
      return parsed.success ? ok(paginate(listComparisonScopeProofs(context.db, parsed.data), paging)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    const id = integer(input.id)
    if (!id) return fail(400, 'invalid_request', 'Positive proof ID required')
    const proof = readComparisonScopeProof(context.db, id)
    if (!proof) return fail(404, 'not_found', 'Proof not found')
    if (input.action === 'get') return ok(proof)
    const paging = page(input.query ?? {})
    if (!paging || Object.keys(input.query ?? {}).some(key => !['page', 'pageSize'].includes(key))) return fail(400, 'invalid_request', 'Invalid audit query')
    return ok(paginate(readComparisonScopeProofAudit(context.db, id), paging))
  } catch (error) {
    if (error instanceof ProofError || error instanceof ProofSourceError) return fail(error.status, error.code, error.message)
    throw error
  }
}
