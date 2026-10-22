import { z } from 'zod'
import type { LogContext } from '../logging'
import { platformQueryInputSchema, platformQueryResultShape, type PlatformLiveQueryInput, type PlatformLiveQueryResult, type PlatformQueryPosition, type PlatformQueryStatus } from './live-query'

export const platformBatchLimitsShape = {
  maxRequests: z.number().int().min(1).max(200).default(200),
  maxRows: z.number().int().min(1).max(5000).default(5000),
  maxDurationMs: z.number().int().min(1).max(120000).default(120000),
  maxResultBytes: z.number().int().min(65536).max(8388608).default(2097152),
}
export const platformBatchInputShape = {
  items: z.array(z.strictObject({ query: platformQueryInputSchema })).min(1).max(50),
  limits: z.strictObject(platformBatchLimitsShape).default(() => ({ maxRequests: 200, maxRows: 5000, maxDurationMs: 120000, maxResultBytes: 2097152 })),
}
export const platformBatchInputSchema = z.strictObject(platformBatchInputShape)
export const platformBatchIdShape = { batchId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }
export const platformBatchStatusSchema = z.strictObject(platformBatchIdShape)
export const platformBatchItemShape = { ...platformBatchIdShape, itemId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }
export const platformBatchItemSchema = z.strictObject(platformBatchItemShape)
export const platformBatchRetryShape = { ...platformBatchIdShape, itemIds: z.array(platformBatchItemShape.itemId).min(1).max(50).refine(ids => new Set(ids).size === ids.length) }
export const platformBatchRetrySchema = z.strictObject(platformBatchRetryShape)
export const PLATFORM_BATCH_KIND = 'platform-query-batch'
export const MAX_BATCH_ATTEMPTS = 10
export interface PlatformBatchParams {
  /** Server-owned context; not accepted by the public input schema. */
  logContext?: LogContext
  items: { itemId: string; query: PlatformLiveQueryInput }[]
  limits: { maxRequests: number; maxRows: number; maxDurationMs: number; maxResultBytes: number }
  retryItemIds?: string[]
}
export interface PlatformBatchItem {
  itemId: string
  status: PlatformQueryStatus
  completeness: 'complete' | 'partial' | 'not_queried'
  /** Append-only query segments retain original page rows, query times and failure history. */
  segments: PlatformLiveQueryResult[]
  unfinished: PlatformQueryPosition[]
}
export interface PlatformBatchResult {
  attempt: number
  completeness: 'complete' | 'partial'
  items: PlatformBatchItem[]
  usage: { requests: number; rows: number }
  limits: PlatformBatchParams['limits']
}
export const platformBatchItemResultShape = {
  itemId: z.string(), status: platformQueryResultShape.status, completeness: platformQueryResultShape.completeness,
  segments: z.array(z.object(platformQueryResultShape)), unfinished: platformQueryResultShape.unfinished,
}
export const platformBatchReceiptShape = { batchId: z.string(), itemIds: z.array(z.string()), state: z.string() }
export const platformBatchResultShape = {
  ...platformBatchReceiptShape,
  progress: z.object({ done: z.number(), total: z.number() }),
  completeness: z.enum(['complete', 'partial']), attempt: z.number(),
  items: z.array(z.object(platformBatchItemResultShape)),
  usage: z.object({ requests: z.number(), rows: z.number() }), limits: z.object(platformBatchLimitsShape),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), error: z.string().nullable(),
}
