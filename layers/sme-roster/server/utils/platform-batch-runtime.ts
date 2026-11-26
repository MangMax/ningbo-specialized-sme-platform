import { requireJobsWritable, startJobs, useJobsDb } from '../../../core/server/utils/postgres-jobs'
import type { LogContext } from '../../../core/lib/logging'
import {
  batchSpec, getPostgresPlatformBatch, getPostgresPlatformBatchItem, registerPlatformBatchJob, retryPostgresPlatformBatch,
} from './platform-batch-query-postgres'
import { PLATFORM_BATCH_KIND, type PlatformBatchParams } from '../../lib/platform/batch-query'

export function platformBatchRuntime(filesDir: string) {
  const db = useJobsDb()
  registerPlatformBatchJob()
  return {
    async submit(input: unknown, context?: LogContext) {
      requireJobsWritable()
      const { runner } = startJobs(filesDir)!
      const parsed = batchSpec.parse(input as Record<string, unknown>)
      if (!parsed.ok) throw Object.assign(new Error(parsed.message), { statusCode: 400 })
      const row = await runner.submit({ kind: PLATFORM_BATCH_KIND, params: parsed.params, logContext: context })
      return { batchId: row.id, itemIds: (row.params.items as PlatformBatchParams['items']).map(item => item.itemId), state: row.state }
    },
    status: (input: unknown) => getPostgresPlatformBatch(db, input),
    item: (input: unknown) => getPostgresPlatformBatchItem(db, input),
    retry: (input: unknown, context?: LogContext) => {
      requireJobsWritable()
      startJobs(filesDir)
      return retryPostgresPlatformBatch(db, input, context)
    },
  }
}
