import { type ProofApiInput, headers, fail, proofCommitRequest, proofPaging, proofListFilter, integer } from './comparison-scope-proof-runtime'
import { importReceiptRedactor } from './import-receipt-redaction-sqlite'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { sanitizeEvidence } from './evidence-redaction'
import { commitComparisonScopeProofs, listComparisonScopeProofs, preflightComparisonScopeProofs, readComparisonScopeProof, readComparisonScopeProofAudit, readComparisonScopeProofBatch } from './comparison-scope-proof'
import { proofRequest, ProofError } from './comparison-scope-proof-model'
import { ProofSourceError } from './comparison-scope-proof-source-model'
type Db = BetterSQLite3Database<typeof schema>
function knownRedactors(context: { db: Db; apiToken?: string | null }) {
  return importReceiptRedactor(context.db, { additionalSecrets: [context.apiToken] }).knownRedactors
}
const paginate = <T>(rows: T[], paging: { page: number; pageSize: number }) => ({ rows: rows.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize), total: rows.length, ...paging })
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
export { type ProofAction, type ProofApiInput, handleRuntimeComparisonProof } from './comparison-scope-proof-runtime'
