import { z } from 'zod'
import { eventCorrectionRequestSchema } from './roster-event-correction'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleEventCorrectionRequest, type EventCorrectionAction } from './roster-event-correction-api'
/** Transport credentials are independent; MCP middleware/writeGuard establishes authorization. */
export function dispatchEventCorrectionMcp(action: EventCorrectionAction, args: Record<string, unknown>, context: { db: BetterSQLite3Database<typeof schema>; authorized?: boolean }) {
  const write = action === 'preflight' || action === 'commit'
  const output = handleEventCorrectionRequest({ action, method: write ? 'POST' : 'GET', id: args.eventId, query: action === 'audit' ? Object.fromEntries(Object.entries({ page: args.page, pageSize: args.pageSize }).filter(([,v]) => v !== undefined)) : undefined, body: args, headers: context.authorized ? { authorization: 'Bearer mcp-event-internal' } : undefined }, { db: context.db, apiToken: 'mcp-event-internal' })
  if (output.status !== 200) { const error = output.body as { error: { code: string; message: string } }; throw Object.assign(new Error(error.error.message), { code: error.error.code, statusCode: output.status }) }
  return output.body
}

/** The SDK builds an object from a raw shape and strips root extras. Validate original RPC input. */
export function eventCorrectionRpcError(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    if (!entry || typeof entry !== 'object') continue
    const rpc = entry as { method?: string; params?: { name?: string; arguments?: unknown }; id?: unknown }
    if (rpc.method !== 'tools/call') continue
    const contracts = {
      preflight_event_corrections: eventCorrectionRequestSchema,
      commit_event_corrections: z.strictObject({ request: eventCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }),
      get_official_event: z.strictObject({ eventId: z.number().int().positive() }),
      get_event_correction_audit: z.strictObject({ eventId: z.number().int().positive(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(100).optional() }),
    }
    const name = rpc.params?.name ?? ''
    if (!Object.hasOwn(contracts, name)) continue
    if (!contracts[name as keyof typeof contracts].safeParse(rpc.params?.arguments).success) return new Response(JSON.stringify({ jsonrpc: '2.0', id: typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null, error: { code: -32602, message: 'Invalid event correction arguments; strict event fields and bounded IDs/paging required' } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
  return null
}
