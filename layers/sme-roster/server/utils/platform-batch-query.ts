import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { PLATFORM_BATCH_KIND, platformBatchStatusSchema, platformBatchItemSchema, platformBatchRetrySchema, type PlatformBatchParams, type PlatformBatchResult } from '../../lib/platform/batch-query'
import { resolvePlatformCookie } from './platform-credential'
import { ensureJobRunnerReady, submitJob, requeueFinishedJob, type JobContext, type JobSpec } from '../../../core/server/utils/job-runner'
import { getJob, setJobResult } from '../../../core/server/utils/job-store'
import { appLog, newLogContext, type LogContext } from '../../../core/lib/logging'
import { batchSpec, platformBatchFailure, runPlatformBatch, validatePlatformBatchConditions, projectPlatformBatch, validatePlatformBatchRetry } from './platform-batch-query-postgres'

type Db = BetterSQLite3Database<typeof schema>

function runSqliteBatch(ctx: JobContext, params: Record<string, unknown>, cookie: string) {
  return runPlatformBatch({
    ...ctx, checkpoint: result => { setJobResult(ctx.db, ctx.jobId, result) },
  }, params, cookie, getJob(ctx.db, ctx.jobId)?.result as PlatformBatchResult | null)
}

const sqliteBatchSpec: JobSpec = {
  ...batchSpec,
  prepare: (params, db) => {
    let snapshot = ''
    try { snapshot = resolvePlatformCookie(undefined, { db }) } catch { /* sanitized query outcome */ }
    validatePlatformBatchConditions(params, snapshot)
    return (ctx, params) => runSqliteBatch(ctx, params, snapshot)
  },
  run: (ctx, params) => runSqliteBatch(ctx, params, ''),
}

export function submitPlatformBatch(db: Db, input: unknown, filesDir: string, logContext?: LogContext) {
  ensureJobRunnerReady(db)
  const parsed = batchSpec.parse(input as Record<string, unknown>)
  if (!parsed.ok) return platformBatchFailure(400, parsed.message)
  const row = submitJob(db, { kind: PLATFORM_BATCH_KIND, params: parsed.params, filesDir, logContext: logContext ?? newLogContext() }, sqliteBatchSpec)
  return { batchId: row.id, itemIds: (row.params.items as PlatformBatchParams['items']).map(item => item.itemId), state: row.state }
}
export function getPlatformBatch(db: Db, input: unknown) {
  const parsed = platformBatchStatusSchema.safeParse(input)
  if (!parsed.success) return platformBatchFailure(400, 'Invalid batch ID')
  ensureJobRunnerReady(db)
  return projectPlatformBatch(getJob(db, parsed.data.batchId))
}

export function getPlatformBatchItem(db: Db, input: unknown) {
  const parsed = platformBatchItemSchema.safeParse(input)
  if (!parsed.success) return platformBatchFailure(400, 'Invalid batch or item ID')
  const batch = getPlatformBatch(db, { batchId: parsed.data.batchId })
  return batch.items.find(item => item.itemId === parsed.data.itemId) ?? platformBatchFailure(404, 'Platform batch item not found')
}

export function retryPlatformBatch(db: Db, input: unknown, filesDir: string, logContext?: LogContext) {
  const parsed = platformBatchRetrySchema.safeParse(input)
  if (!parsed.success) return platformBatchFailure(400, 'Invalid batch retry parameters')
  const batch = getPlatformBatch(db, { batchId: parsed.data.batchId })
  validatePlatformBatchRetry(batch, parsed.data.itemIds)
  const row = getJob(db, batch.batchId)!
  const retryContext = logContext ?? newLogContext()
  if (!requeueFinishedJob(db, { id: batch.batchId, kind: PLATFORM_BATCH_KIND, params: { ...row.params, retryItemIds: parsed.data.itemIds }, filesDir, logContext: retryContext }, sqliteBatchSpec)) return platformBatchFailure(409, 'Platform batch is still active')
  appLog({ module: 'sme-roster', source: 'platform', operation: 'platform.batch.retry', outcome: 'started', counts: { total: parsed.data.itemIds.length } },
    { ...retryContext, taskId: batch.batchId, batchId: batch.batchId })
  return { batchId: batch.batchId, itemIds: batch.itemIds, state: 'queued' as const }
}
