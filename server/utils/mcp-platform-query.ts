import { platformQueryInputSchema } from '../../lib/platform/live-query'

/** Toolkit's raw-shape SDK strips unknown keys before a handler. Validate the original
 * RPC arguments in middleware as well, so unsupported filters/credentials are rejected.
 */
export function platformQueryRpcError(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    if (!entry || typeof entry !== 'object') continue
    const rpc = entry as { method?: string; params?: { name?: string; arguments?: unknown }; id?: unknown }
    if (rpc.method !== 'tools/call' || rpc.params?.name !== 'query_platform') continue
    const parsed = platformQueryInputSchema.safeParse(rpc.params.arguments)
    if (!parsed.success || parsed.data.source === 'businessList' || (!parsed.data.name && !parsed.data.uscc)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null, error: { code: -32602, message: 'Invalid or unsupported platform query parameters' } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
  }
  return null
}
