import { z } from 'zod'
import { platformBatchRetryShape } from '../../lib/platform/batch-query'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { platformBatchRuntime } from './platform-batch-runtime'
import type { LogContext } from '../../../core/lib/logging'
type BatchAction = 'submit' | 'status' | 'item' | 'retry'
type BatchRequest = { body?: unknown; batchId?: string; itemId?: string; headers?: Record<string, string | undefined> }
type BatchRequestContext = { apiToken?: string | null; filesDir: string; logContext?: LogContext }
type BatchOperations = ReturnType<typeof platformBatchRuntime>
type BatchOperationFactory = () => {
  [Action in keyof BatchOperations]: (...args: Parameters<BatchOperations[Action]>) =>
    Awaited<ReturnType<BatchOperations[Action]>> | ReturnType<BatchOperations[Action]>
}

export function handlePlatformBatchRequest(action: BatchAction, req: BatchRequest, ctx: BatchRequestContext) {
  return handlePlatformBatchTransport(action, req, ctx, () => platformBatchRuntime(ctx.filesDir))
}

export async function handlePlatformBatchTransport(action: BatchAction, req: BatchRequest, ctx: BatchRequestContext, runtime: BatchOperationFactory) {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if ((action === 'submit' || action === 'retry') && !resolveApiAuth({ given: readApiToken(req.headers), configured: ctx.apiToken }).writeAuthorized) return { status: 401, headers, body: { error: 'Platform batch submission/retry requires API authorization' } }
  try {
    if (action === 'retry' && !z.strictObject({ itemIds: platformBatchRetryShape.itemIds }).safeParse(req.body).success) return { status: 400, headers, body: { error: 'Invalid batch retry parameters' } }
    const batch = runtime()
    const body = await (action === 'submit' ? batch.submit(req.body, ctx.logContext)
      : action === 'retry' ? batch.retry({ ...req.body as object, batchId: req.batchId }, ctx.logContext)
      : action === 'item' ? batch.item({ batchId: req.batchId, itemId: req.itemId })
      : batch.status({ batchId: req.batchId }))
    if ((action === 'submit' || action === 'retry') && 'batchId' in body) headers.location = `/api/platform/batches/${body.batchId}`
    return { status: action === 'submit' || action === 'retry' ? 202 : 200, headers, body }
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    return { status, headers, body: { error: status === 500 ? 'Platform batch operation failed' : (error as Error).message } }
  }
}
