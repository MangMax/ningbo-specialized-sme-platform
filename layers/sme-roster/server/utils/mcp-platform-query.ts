import { platformBatchInputSchema, platformBatchStatusSchema, platformBatchItemSchema, platformBatchRetrySchema } from '../../lib/platform/batch-query'
import { platformQueryInputSchema } from '../../lib/platform/live-query'
import { platformEvidenceInputSchema } from '../../lib/platform/evidence-read'
import type { LogContext } from '../../../core/lib/logging'

/** Per-request toolkit hook passes server context through a non-wire symbol. */
export const platformMcpContextKey = Symbol('platform-log-context')
export function platformMcpLogContext(extra?: unknown): LogContext | undefined {
  return (extra as { [platformMcpContextKey]?: LogContext } | undefined)?.[platformMcpContextKey]
}

/** Toolkit's raw-shape SDK strips unknown keys before a handler. Validate the original
 * RPC arguments in middleware as well, so unsupported filters/credentials are rejected.
 */
export function platformQueryRpcError(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    if (!entry || typeof entry !== 'object') continue
    const rpc = entry as { method?: string; params?: { name?: string; arguments?: unknown }; id?: unknown }
    if (rpc.method !== 'tools/call') continue
    const contracts = { get_platform_query_evidence: platformEvidenceInputSchema, query_platform: platformQueryInputSchema, submit_platform_batch: platformBatchInputSchema, get_platform_batch: platformBatchStatusSchema, get_platform_batch_item: platformBatchItemSchema, retry_platform_batch: platformBatchRetrySchema } as const
    if (!Object.hasOwn(contracts, rpc.params?.name ?? '')) continue
    const contract = contracts[rpc.params?.name as keyof typeof contracts]
    if (!contract) continue
    const parsed = contract.safeParse(rpc.params?.arguments)
    if (!parsed.success) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null, error: { code: -32602, message: 'Invalid or unsupported platform query parameters' } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
  }
  return null
}
