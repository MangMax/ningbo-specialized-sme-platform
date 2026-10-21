import { z } from 'zod'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'

export const currentQualifiedFilterSchema = z.strictObject({
  titleCode: z.enum(CURRENT_TITLES),
  q: z.string().trim().min(1).max(120).optional(),
  district: z.string().trim().min(1).max(40).optional(),
  sort: z.enum(['id_asc', 'name_asc', 'name_desc']).optional(),
  page: z.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
})

export function parseCurrentQualifiedQuery(query: Record<string, unknown>) {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    raw[key] = key === 'page' || key === 'pageSize' ? typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value : value
  }
  return currentQualifiedFilterSchema.safeParse(raw)
}

/** Validate original RPC arguments before the toolkit's raw-shape SDK strips keys. */
export function currentQualifiedRpcError(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    if (!entry || typeof entry !== 'object') continue
    const rpc = entry as { method?: string; params?: { name?: string; arguments?: unknown }; id?: unknown }
    if (rpc.method !== 'tools/call' || rpc.params?.name !== 'list_current_qualified_enterprises') continue
    if (!currentQualifiedFilterSchema.safeParse(rpc.params.arguments).success) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null, error: { code: -32602, message: 'Invalid or unsupported current qualified enterprise query parameters' } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
  }
  return null
}
