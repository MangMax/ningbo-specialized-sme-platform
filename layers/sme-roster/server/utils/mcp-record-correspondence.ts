import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { handleRecordCorrespondenceRequest, handlePostgresCorrespondenceRequest, type CorrespondenceAction, type CorrespondenceApiInput } from './record-correspondence-api'

/** Same application adapter as REST; MCP middleware and tool discovery guard write calls. */
export async function dispatchRecordCorrespondenceMcp(action: CorrespondenceAction, args: Record<string, unknown>, context: { db: BetterSQLite3Database<typeof schema>; authorized?: boolean }) {
  try {
    // Tool contexts defer useDb() with a getter so acquisition failures are
    // sanitized by this same application boundary, including uncached opens.
    const write = ['preflight', 'commit', 'batch'].includes(action)
    const input: CorrespondenceApiInput = { action, method: ['list', 'get', 'audit', 'source', 'batch'].includes(action) ? 'GET' : 'POST', query: action === 'list' ? args : action === 'audit' ? { page: args.page, pageSize: args.pageSize } : undefined, body: action === 'commit' ? { request: args.request, planHash: args.planHash } : args, id: args.id, kind: args.kind, key: args.idempotencyKey, headers: write && context.authorized ? { authorization: 'Bearer mcp-internal-authorized' } : undefined }
    const apiToken = write ? 'mcp-internal-authorized' : null
    const output = await handlePostgresCorrespondenceRequest(input, apiToken)
      ?? handleRecordCorrespondenceRequest(input, { db: context.db, apiToken })
    if (output.status !== 200) {
      const { error } = output.body as { error: { code: string; message: string } }
      // Validation diagnostics can include arbitrary rejected keys from input.
      const body = { error: { code: error.code, message: error.code === 'invalid_request' ? 'Invalid correspondence request' : error.message } }
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
    }
    return output.body
  } catch {
    // Never forward arbitrary exception messages, stacks, or custom properties.
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'internal_error', message: 'Correspondence operation failed' } }) }] }
  }
}
