import { getHeapStatistics } from 'node:v8'
import { appManifests } from '../../../../lib/installed-manifests'
import { installAppModules } from '../../../../lib/app-modules'
import { closePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { usePostgresRosterDb } from '../../server/utils/postgres-roster-db'
import { validateReceiptRuntimeContext, type ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { initializeWorkerLogging, closeApplicationLogging, type LogContext } from '../../../core/lib/logging'
import { writePostgresCurrentWorkbook } from './current-workbook-postgres'
import { CurrentWorkbookLimitError } from './current-workbook-renderer'
import { CURRENT_RULE_VERSION, type CurrentTitle } from './current-qualification-model'

export type CurrentExportRequest = { title: CurrentTitle; temporaryPath: string; jobId: string; logContext?: LogContext; receiptRuntime?: ReceiptRuntimeContext }
export type CurrentExportResponse =
  | { type: 'progress'; done: number; total: number; snapshotStartedAt: string; snapshotId: string; ruleVersion: string }
  | { type: 'done'; result: Awaited<ReturnType<typeof writePostgresCurrentWorkbook>> & {
    executor: { peakRssBytes: number; heapLimitBytes: number; heapUsedBytes: number }
  } }
  | { type: 'failure'; message: string }

installAppModules(appManifests)
initializeWorkerLogging()
process.on('disconnect', () => process.exit(1))

process.once('message', async (request: CurrentExportRequest) => {
  const send = (response: CurrentExportResponse) => process.send?.(response)
  try {
    const progress = (done: number, total: number, snapshotStartedAt: string) =>
      send({ type: 'progress', done, total, snapshotStartedAt, snapshotId: request.jobId, ruleVersion: CURRENT_RULE_VERSION })
    const context = { ...request.logContext, taskId: request.jobId }
    const receiptRuntime = Object.hasOwn(request, 'receiptRuntime') ? validateReceiptRuntimeContext(request.receiptRuntime) : undefined
    const result = await writePostgresCurrentWorkbook(usePostgresRosterDb(), request.title, request.temporaryPath, progress, context, receiptRuntime)
    send({ type: 'done', result: { ...result, executor: { peakRssBytes: process.resourceUsage().maxRSS * 1024, heapLimitBytes: getHeapStatistics().heap_size_limit, heapUsedBytes: process.memoryUsage().heapUsed } } })
  } catch (error) {
    send({ type: 'failure', message: error instanceof CurrentWorkbookLimitError ? error.message : '当前名录导出执行失败；请核对数据或资源限制后重新提交' })
  }
  // Report the business result before bounded logging shutdown.
  await Promise.allSettled([closeApplicationLogging(), closePostgresDirectoryDb()])
  process.disconnect?.()
})
