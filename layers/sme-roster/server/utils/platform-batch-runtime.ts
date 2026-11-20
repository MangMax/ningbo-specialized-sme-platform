import { useDb } from '@db'
import { startPostgresJobs } from '../../../core/server/public'
import type { LogContext } from '../../../core/lib/logging'
import {
  batchSpec, getPlatformBatch, getPlatformBatchItem, getPostgresPlatformBatch, getPostgresPlatformBatchItem,
  registerPlatformBatchJob, retryPlatformBatch, retryPostgresPlatformBatch, submitPlatformBatch,
} from './platform-batch-query'
import { PLATFORM_BATCH_KIND, type PlatformBatchParams } from '../../lib/platform/batch-query'

export function platformBatchRuntime(filesDir: string, sqlite: () => Parameters<typeof getPlatformBatch>[0] = useDb) {
  const postgres = startPostgresJobs(filesDir)
  if (!postgres) {
    return {
      submit: (input: unknown, context?: LogContext) => submitPlatformBatch(sqlite(), input, filesDir, context),
      status: (input: unknown) => getPlatformBatch(sqlite(), input),
      item: (input: unknown) => getPlatformBatchItem(sqlite(), input),
      retry: (input: unknown, context?: LogContext) => retryPlatformBatch(sqlite(), input, filesDir, context),
    }
  }

  const { db, runner } = postgres
  registerPlatformBatchJob()
  return {
    async submit(input: unknown) {
      const parsed = batchSpec.parse(input as Record<string, unknown>)
      if (!parsed.ok) throw Object.assign(new Error(parsed.message), { statusCode: 400 })
      const row = await runner.submit({ kind: PLATFORM_BATCH_KIND, params: parsed.params })
      return { batchId: row.id, itemIds: (row.params.items as PlatformBatchParams['items']).map(item => item.itemId), state: row.state }
    },
    status: (input: unknown) => getPostgresPlatformBatch(db, input),
    item: (input: unknown) => getPostgresPlatformBatchItem(db, input),
    retry: (input: unknown, context?: LogContext) => retryPostgresPlatformBatch(db, input, context),
  }
}
