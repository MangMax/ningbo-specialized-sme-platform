import { z } from 'zod'
import { applicationLogs } from '../../lib/logging'
import { dispatchLogAction, type LogAction } from '../../lib/logging/application'
/** SDK schemas stay thin; the same application validates both transports. */
export const logFilterSchema = {
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
