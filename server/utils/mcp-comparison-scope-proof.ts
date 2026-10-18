import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleComparisonScopeProofRequest, type ProofAction } from './comparison-scope-proof-api'

export function dispatchComparisonScopeProofMcp(action: ProofAction, args: Record<string, unknown>, context: { db: BetterSQLite3Database<typeof schema>; authorized?: boolean }) {
  const write = ['preflight', 'commit', 'batch'].includes(action)
  const output = handleComparisonScopeProofRequest({ action, method: ['preflight', 'commit'].includes(action) ? 'POST' : 'GET', body: args, query: action === 'list' ? args : action === 'audit' ? { page: args.page, pageSize: args.pageSize } : undefined, id: args.id, key: args.idempotencyKey, headers: write && context.authorized ? { authorization: 'Bearer mcp-internal-authorized' } : undefined }, { db: context.db, apiToken: write ? 'mcp-internal-authorized' : null })
  if (output.status !== 200) {
    const error = (output.body as { error: { code: string; message: string } }).error
    throw Object.assign(new Error(error.message), { code: error.code, statusCode: output.status })
  }
  return output.body
}
