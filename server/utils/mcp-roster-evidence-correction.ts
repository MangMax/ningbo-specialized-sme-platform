import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleEvidenceCorrectionRequest, type EvidenceCorrectionAction } from './roster-evidence-correction-api'
export async function dispatchEvidenceCorrectionMcp(action: EvidenceCorrectionAction, args: Record<string, unknown>, context: { db: BetterSQLite3Database<typeof schema>; filesDir?: string; authorized?: boolean }) {
  const write = ['preflight', 'commit', 'batch'].includes(action)
  const output = await handleEvidenceCorrectionRequest({ action, method: ['preflight', 'commit'].includes(action) ? 'POST' : 'GET', body: args, id: args.id, key: args.idempotencyKey, query: action === 'audit' ? Object.fromEntries(Object.entries({ page: args.page, pageSize: args.pageSize }).filter(([, v]) => v !== undefined)) : undefined, headers: write && context.authorized ? { authorization: 'Bearer mcp-internal-authorized' } : undefined }, { db: context.db, filesDir: context.filesDir, apiToken: 'mcp-internal-authorized' })
  if (output.status !== 200) {
    const error = (output.body as { error: { code: string; message: string } }).error
    throw Object.assign(new Error(error.message), { code: error.code, statusCode: output.status })
  }
  return output.body
}
