import { handlePlatformBatchTransport } from './platform-batch-http'
import { getPlatformBatch, getPlatformBatchItem, retryPlatformBatch, submitPlatformBatch } from './platform-batch-query'

type BatchContext = Parameters<typeof handlePlatformBatchTransport>[2] & { db: Parameters<typeof getPlatformBatch>[0] }

export function handleSqlitePlatformBatchRequest(action: Parameters<typeof handlePlatformBatchTransport>[0], req: Parameters<typeof handlePlatformBatchTransport>[1], ctx: BatchContext) {
  return handlePlatformBatchTransport(action, req, ctx, () => ({
    submit: (input, context) => submitPlatformBatch(ctx.db, input, ctx.filesDir, context),
    status: input => getPlatformBatch(ctx.db, input),
    item: input => getPlatformBatchItem(ctx.db, input),
    retry: (input, context) => retryPlatformBatch(ctx.db, input, ctx.filesDir, context),
  }))
}
