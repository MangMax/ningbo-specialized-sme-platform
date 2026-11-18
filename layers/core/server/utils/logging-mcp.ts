import { z } from 'zod'
import { validatePolicy } from '../../lib/logging/service'
import { applicationLogs, UNLABELED_LOG_MODULE } from '../../lib/logging'
import { dispatchLogAction, type LogAction } from '../../lib/logging/application'
/** SDK schemas stay thin; the same application validates both transports. */
export const logFilterSchema = {
  module: z.string().max(128).describe(`模块 id，或 ${UNLABELED_LOG_MODULE}（未标注）`).optional(),
  from: z.string().max(32).optional(), to: z.string().max(32).optional(),
  level: z.string().max(16).optional(), source: z.string().max(16).optional(),
  operation: z.string().max(96).optional(), outcome: z.string().max(32).optional(),
  requestId: z.string().max(128).optional(), traceId: z.string().max(128).optional(),
  taskId: z.string().max(128).optional(), fileId: z.number().int().positive().optional(),
  batchId: z.union([z.string().max(128), z.number().int()]).optional(),
  resourceId: z.union([z.string().max(128), z.number().int()]).optional(),
}
/** Only called by tools with enabled:writeGuard + protected-tool middleware. No fabricated actor/token. */
export async function loggingMcpResult(action: LogAction, input: Record<string, unknown>) {
  const result = await dispatchLogAction(applicationLogs(), action, input, true)
  if (result.status !== 200) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result.body) }] }
  return result.body as Record<string, unknown>
}

// The SDK normalizes raw shapes with z.object(), stripping unknown top-level
// keys. Validate original policy arguments before that normalization so REST
// and MCP reject the same invalid policy, including GET response fields.
export function runtimeLogPolicyRpcError(body: unknown): Response | undefined {
  for (const call of Array.isArray(body) ? body : [body]) {
    if (call?.method !== 'tools/call' || call?.params?.name !== 'set_runtime_log_policy') continue
    try { validatePolicy(call.params.arguments) }
    catch {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? null, error: { code: -32602, message: 'Invalid log policy', data: { code: 'invalid_log_input' } } }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
  }
}
