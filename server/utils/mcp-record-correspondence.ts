import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRecordCorrespondenceRequest, type CorrespondenceAction } from './record-correspondence-api'

/** Same application adapter as REST; MCP middleware and tool discovery guard write calls. */
export function dispatchRecordCorrespondenceMcp(action: CorrespondenceAction, args: Record<string, unknown>, context: { db: BetterSQLite3Database<typeof schema>; authorized?: boolean }) {
  const write = ['preflight', 'commit', 'batch'].includes(action)
  const output = handleRecordCorrespondenceRequest({ action, method: ['list', 'get', 'audit', 'source', 'batch'].includes(action) ? 'GET' : 'POST', query: action === 'list' ? args : action === 'audit' ? { page: args.page, pageSize: args.pageSize } : undefined, body: action === 'commit' ? { request: args.request, planHash: args.planHash } : args, id: args.id, kind: args.kind, key: args.idempotencyKey, headers: write && context.authorized ? { authorization: 'Bearer mcp-internal-authorized' } : undefined }, { db: context.db, apiToken: write ? 'mcp-internal-authorized' : null })
  if (output.status !== 200) {
    const error = (output.body as { error: { code: string; message: string } }).error
    throw Object.assign(new Error(error.message), { code: error.code, statusCode: output.status })
  }
  return output.body
}
