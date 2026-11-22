import { eventCorrectionMcpResult } from './mcp-event-correction-runtime'
import type { McpToolCallbackResult } from '@nuxtjs/mcp-toolkit/server'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { handleEventCorrectionRequest, type EventCorrectionAction } from './roster-event-correction-api'
/** Transport credentials are independent; MCP middleware/writeGuard establishes authorization. */
export function dispatchEventCorrectionMcp(action: EventCorrectionAction, args: Record<string, unknown>, context: { db: BetterSQLite3Database<typeof schema>; authorized?: boolean }): McpToolCallbackResult {
  const write = action === 'preflight' || action === 'commit'
  const output = handleEventCorrectionRequest({ action, method: write ? 'POST' : 'GET', id: args.eventId, query: action==='get' ? Object.fromEntries(Object.entries(args).filter(([key,v])=>key!=='eventId' && v!==undefined)) : action === 'audit' ? Object.fromEntries(Object.entries({ page: args.page, pageSize: args.pageSize }).filter(([,v]) => v !== undefined)) : undefined, body: args, headers: context.authorized ? { authorization: 'Bearer mcp-event-internal' } : undefined }, { db: context.db, apiToken: 'mcp-event-internal' })
  return eventCorrectionMcpResult(action, args, output)
}
export { isEventCorrectionMcpResult, dispatchPostgresEventCorrectionMcp, eventCorrectionRpcError } from './mcp-event-correction-runtime'
