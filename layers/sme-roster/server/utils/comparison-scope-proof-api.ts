import { sql } from 'drizzle-orm'
import { readPostgresRosterPage } from '../../lib/roster/postgres-rows'
import { importPostgresReceiptRedactor, importReceiptRedactor } from './import-receipt-redaction'
import { usePostgresRosterDb } from './postgres-roster-db'
import { preflightPostgresComparisonProof, commitPostgresComparisonProof } from './comparison-scope-proof-write-postgres'
import { pagePostgresComparisonProofs, readPostgresComparisonProof } from './comparison-scope-proof-postgres'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { sanitizeEvidence } from './record-correspondence-read'
import { commitComparisonScopeProofs, listComparisonScopeProofs, preflightComparisonScopeProofs, proofRequest, ProofError, readComparisonScopeProof, readComparisonScopeProofAudit, readComparisonScopeProofBatch } from './comparison-scope-proof'
import { ProofSourceError } from './comparison-scope-proof-source'

type Db = BetterSQLite3Database<typeof schema>
export type ProofAction = 'preflight' | 'commit' | 'list' | 'get' | 'audit' | 'batch'
export interface ProofApiInput { action: ProofAction; method: string; body?: unknown; query?: Record<string, unknown>; id?: unknown; key?: unknown; headers?: Record<string, string | undefined> }
const headers = { 'cache-control': 'no-store' }
const fail = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
function knownRedactors(context: { db: Db; apiToken?: string | null }) {
  return importReceiptRedactor(context.db, { additionalSecrets: [context.apiToken] }).knownRedactors
}
const integer = (value: unknown) => { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value; return Number.isSafeInteger(n) && (n as number) > 0 ? n as number : null }
const page = (query: Record<string, unknown>) => { const p = query.page == null ? 1 : integer(query.page); const s = query.pageSize == null ? 50 : integer(query.pageSize); return p && s && s <= 200 ? { page: p, pageSize: s } : null }
const paginate = <T>(rows: T[], paging: { page: number; pageSize: number }) => ({ rows: rows.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: rows.length, ...paging })

const proofListFilter = z.object({
  kind: z.enum(['official_coverage', 'current_source_equivalence']).optional(),
  status: z.enum(['candidate', 'confirmed', 'revoked']).optional(),
})
function proofPaging(query: Record<string, unknown>, list = false) {
  const fields = list ? ['kind', 'status', 'page', 'pageSize'] : ['page', 'pageSize']
  return Object.keys(query).every(key => fields.includes(key)) ? page(query) : null
}

const proofCommitRequest = z.strictObject({ request: proofRequest, planHash: z.string().regex(/^[0-9a-f]{64}$/) })

export async function handleRuntimeComparisonProof(input: ProofApiInput, apiToken?: string | null) {
  const planning = input.action === 'preflight' || input.action === 'commit'
  const db = usePostgresRosterDb()
  if (!db) return
  if ((planning || input.action === 'batch') && !resolveApiAuth({ given: readApiToken(input.headers), configured: apiToken }).writeAuthorized) {
    return fail(401, 'unauthorized', 'Configured API token required')
  }
  const method = planning ? 'POST' : 'GET'
  if (input.method !== method) return fail(405, 'method_not_allowed', method + ' required')
  if (planning) {
    const { knownRedactors } = await importPostgresReceiptRedactor(db, { additionalSecrets: [apiToken] })
    const ok = (value: object) => ({ status: 200, headers, body: sanitizeEvidence({ ...value }, knownRedactors) })
    const safe = (value: unknown) => JSON.stringify(sanitizeEvidence(value, knownRedactors)) === JSON.stringify(value)
    try {
      if (input.action === 'preflight') {
        const parsed = proofRequest.safeParse(input.body)
        if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error))
        if (!safe(parsed.data)) return fail(400, 'credential_in_evidence', 'Credential-like data cannot be stored in a proof decision')
        return ok(await preflightPostgresComparisonProof(usePostgresRosterDb(true)!, parsed.data))
      }
      const parsed = proofCommitRequest.safeParse(input.body)
      if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error))
      if (!safe(parsed.data.request)) return fail(400, 'credential_in_evidence', 'Credential-like data cannot be stored in a proof decision')
      return ok(await commitPostgresComparisonProof(usePostgresRosterDb(true)!, parsed.data.request, parsed.data.planHash))
    } catch (error) {
      if (error instanceof ProofError || error instanceof ProofSourceError) return fail(error.status, error.code, error.message)
      throw error
    }
  }
  return db.transaction(async tx => {
    const { knownRedactors } = await importPostgresReceiptRedactor(tx, { additionalSecrets: [apiToken] })
    const ok = (body: object) => ({ status: 200, headers, body: sanitizeEvidence({ ...body }, knownRedactors) })
    const query = input.query ?? {}
    if (input.action === 'batch') {
      if (typeof input.key !== 'string' || !input.key.trim()) return fail(400, 'invalid_request', 'Idempotency key required')
      const { rows: [batch] } = await tx.execute<{ receipt: object | null }>(sql`
        SELECT summary::json AS receipt FROM import_batch
        WHERE idempotency_key=${input.key} AND source_kind='comparison_scope_proof' AND status='committed'`)
      return batch?.receipt ? ok(batch.receipt) : fail(404, 'not_found', 'Committed receipt not found')
    }
    if (input.action === 'list') {
      const paging = proofPaging(query, true)
      if (!paging) return fail(400, 'invalid_request', 'Invalid list query')
      const parsed = proofListFilter.safeParse(query)
      return parsed.success ? ok(await pagePostgresComparisonProofs(tx, { ...parsed.data, ...paging }))
        : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    const id = integer(input.id)
    if (!id) return fail(400, 'invalid_request', 'Positive proof ID required')
    const proof = await readPostgresComparisonProof(tx, id)
    if (!proof) return fail(404, 'not_found', 'Proof not found')
    if (input.action === 'get') return ok(proof)
    const paging = proofPaging(query)
    if (!paging) return fail(400, 'invalid_request', 'Invalid audit query')
    return ok(await readPostgresRosterPage(tx, schema.comparisonScopeProofAudit,
      sql`FROM comparison_scope_proof_audit p WHERE p.proof_id=${id}`, paging.page, paging.pageSize))
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function handleComparisonScopeProofRequest(input: ProofApiInput, context: { db: Db; apiToken?: string | null }) {
  try {
    const ok = (body: object) => ({ status: 200, headers, body: sanitizeEvidence({ ...body }, knownRedactors(context)) })
    const write = ['preflight', 'commit', 'batch'].includes(input.action)
    if (write && !resolveApiAuth({ given: readApiToken(input.headers), configured: context.apiToken }).writeAuthorized) return fail(401, 'unauthorized', 'Configured API token required')
    const method = ['preflight', 'commit'].includes(input.action) ? 'POST' : 'GET'
    if (input.method !== method) return fail(405, 'method_not_allowed', `${method} required`)
    if (input.action === 'preflight') {
      const parsed = proofRequest.safeParse(input.body)
      if (parsed.success && JSON.stringify(sanitizeEvidence(parsed.data, knownRedactors(context))) !== JSON.stringify(parsed.data)) return fail(400, 'credential_in_evidence', 'Credential-like data cannot be stored in a proof decision')
      return parsed.success ? ok(preflightComparisonScopeProofs(context.db, parsed.data)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'commit') {
      const parsed = proofCommitRequest.safeParse(input.body)
      if (parsed.success && JSON.stringify(sanitizeEvidence(parsed.data.request, knownRedactors(context))) !== JSON.stringify(parsed.data.request)) return fail(400, 'credential_in_evidence', 'Credential-like data cannot be stored in a proof decision')
      return parsed.success ? ok(commitComparisonScopeProofs(context.db, parsed.data.request, parsed.data.planHash)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    if (input.action === 'batch') {
      if (typeof input.key !== 'string' || !input.key.trim()) return fail(400, 'invalid_request', 'Idempotency key required')
      const receipt = readComparisonScopeProofBatch(context.db, input.key)
      return receipt ? ok(receipt) : fail(404, 'not_found', 'Committed receipt not found')
    }
    if (input.action === 'list') {
      const query = input.query ?? {}
      const paging = proofPaging(query, true)
      if (!paging) return fail(400, 'invalid_request', 'Invalid list query')
      const parsed = proofListFilter.safeParse(query)
      return parsed.success ? ok(paginate(listComparisonScopeProofs(context.db, parsed.data), paging)) : fail(400, 'invalid_request', z.prettifyError(parsed.error))
    }
    const id = integer(input.id)
    if (!id) return fail(400, 'invalid_request', 'Positive proof ID required')
    const proof = readComparisonScopeProof(context.db, id)
    if (!proof) return fail(404, 'not_found', 'Proof not found')
    if (input.action === 'get') return ok(proof)
    const paging = proofPaging(input.query ?? {})
    if (!paging) return fail(400, 'invalid_request', 'Invalid audit query')
    return ok(paginate(readComparisonScopeProofAudit(context.db, id), paging))
  } catch (error) {
    if (error instanceof ProofError || error instanceof ProofSourceError) return fail(error.status, error.code, error.message)
    throw error
  }
}
