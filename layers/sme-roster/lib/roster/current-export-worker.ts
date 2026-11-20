import { appManifests } from '../../../../lib/installed-manifests'
import { installAppModules } from '../../../../lib/app-modules'
import { assertCurrentWorkerRuntime } from './current-worker-admission'
import { validateReceiptRuntimeContext, type ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { getHeapStatistics } from 'node:v8'
import Database from 'better-sqlite3'
import { writePostgresCurrentWorkbook } from './current-workbook-postgres'
import { closePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { usePostgresRosterDb } from '../../server/utils/postgres-roster-db'
import { CurrentWorkbookLimitError, writeCurrentWorkbook } from './current-workbook'
import { CURRENT_RULE_VERSION, type CurrentTitle } from './current-qualification'
import { initializeWorkerLogging, closeApplicationLogging, type LogContext } from '../../../core/lib/logging'
installAppModules(appManifests)
initializeWorkerLogging()
process.on('disconnect', () => process.exit(1))
process.once('message', async (request: { dbPath: string; postgres?: boolean; title: CurrentTitle; temporaryPath: string; jobId: string; logContext?: LogContext; receiptRuntime?: ReceiptRuntimeContext }) => {
  let db: Database.Database | undefined
  let response: object
  try {
    const progress = (done: number, total: number, snapshotStartedAt: string) =>
      process.send?.({ type: 'progress', done, total, snapshotStartedAt, snapshotId: request.jobId, ruleVersion: CURRENT_RULE_VERSION })
    const context = { ...request.logContext, taskId: request.jobId }
    let result: Awaited<ReturnType<typeof writeCurrentWorkbook>>
    if (request.postgres) {
      const postgres = usePostgresRosterDb()
      if (!postgres) throw new Error('PostgreSQL roster connection unavailable')
      result = await writePostgresCurrentWorkbook(postgres, request.title, request.temporaryPath, progress, context)
    } else {
      const receiptRuntime = Object.hasOwn(request, 'receiptRuntime') ? validateReceiptRuntimeContext(request.receiptRuntime) : undefined
      db = new Database(request.dbPath, { readonly: true, fileMustExist: true })
      assertCurrentWorkerRuntime(db)
      result = await writeCurrentWorkbook(db, request.title, request.temporaryPath, progress, context, receiptRuntime)
    }
    response = { type: 'done', result: {...result,executor:{peakRssBytes:process.resourceUsage().maxRSS*1024,heapLimitBytes:getHeapStatistics().heap_size_limit,heapUsedBytes:process.memoryUsage().heapUsed}} }
  } catch (error) { response = { type: 'failure', message: error instanceof CurrentWorkbookLimitError ? error.message : '当前名录导出执行失败；请核对数据或资源限制后重新提交' } }
  finally { db?.close() }
  // Report the business result before bounded logging shutdown so a drain fault
  // cannot turn completed work into the supervisor's execution timeout.
  process.send?.(response)
  await Promise.allSettled([closeApplicationLogging(), closePostgresDirectoryDb()])
  process.disconnect?.()
})
