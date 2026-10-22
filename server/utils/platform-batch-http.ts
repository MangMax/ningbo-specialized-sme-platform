import { z } from 'zod'
import { platformBatchRetryShape } from '../../lib/platform/batch-query'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { readApiToken, resolveApiAuth } from './api-auth'
import { getPlatformBatch, getPlatformBatchItem, retryPlatformBatch, submitPlatformBatch } from './platform-batch-query'
import type { LogContext } from '../../lib/logging'
export async function handlePlatformBatchRequest(action: 'submit' | 'status' | 'item' | 'retry', req: { body?: unknown; batchId?: string; itemId?: string; headers?: Record<string, string | undefined> }, ctx: { db: BetterSQLite3Database<typeof schema>; apiToken?: string | null; filesDir: string; logContext?: LogContext }) {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if ((action === 'submit' || action === 'retry') && !resolveApiAuth({ given: readApiToken(req.headers), configured: ctx.apiToken }).writeAuthorized) return { status: 401, headers, body: { error: 'Platform batch submission/retry requires API authorization' } }
  try {
    if (action === 'retry' && !z.strictObject({ itemIds: platformBatchRetryShape.itemIds }).safeParse(req.body).success) return { status: 400, headers, body: { error: 'Invalid batch retry parameters' } }
    const body = action === 'submit' ? submitPlatformBatch(ctx.db, req.body, ctx.filesDir, ctx.logContext) : action === 'retry' ? retryPlatformBatch(ctx.db, req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body, batchId: req.batchId } : req.body, ctx.filesDir, ctx.logContext) : action === 'item' ? getPlatformBatchItem(ctx.db, { batchId: req.batchId, itemId: req.itemId }) : getPlatformBatch(ctx.db, { batchId: req.batchId })
    if ((action === 'submit' || action === 'retry') && 'batchId' in body) headers.location = `/api/platform/batches/${body.batchId}`
    return { status: action === 'submit' || action === 'retry' ? 202 : 200, headers, body }
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500
    return { status, headers, body: { error: status === 500 ? 'Platform batch operation failed' : (error as Error).message } }
  }
}
