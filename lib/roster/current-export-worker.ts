import { assertCurrentWorkerRuntime } from './current-worker-admission'
import { validateReceiptRuntimeContext, type ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { getHeapStatistics } from 'node:v8'
import Database from 'better-sqlite3'
import { CurrentWorkbookLimitError, writeCurrentWorkbook } from './current-workbook'
import { CURRENT_RULE_VERSION, type CurrentTitle } from './current-qualification'
import { initializeWorkerLogging, closeApplicationLogging, type LogContext } from '../../layers/core/lib/logging'
initializeWorkerLogging()
process.on('disconnect', () => process.exit(1))
process.once('message', async (request: { dbPath: string; title: CurrentTitle; temporaryPath: string; jobId: string; logContext?: LogContext; receiptRuntime?: ReceiptRuntimeContext }) => {
  let db: Database.Database | undefined
  let response: object
  try {
    const receiptRuntime = Object.hasOwn(request, 'receiptRuntime') ? validateReceiptRuntimeContext(request.receiptRuntime) : undefined
    db = new Database(request.dbPath, { readonly: true, fileMustExist: true })
    assertCurrentWorkerRuntime(db)
    const result = await writeCurrentWorkbook(db, request.title, request.temporaryPath, (done,total,snapshotStartedAt) => process.send?.({ type: 'progress', done,total,snapshotStartedAt,snapshotId:request.jobId,ruleVersion:CURRENT_RULE_VERSION }), { ...request.logContext, taskId: request.jobId }, receiptRuntime)
    response = { type: 'done', result: {...result,executor:{peakRssBytes:process.resourceUsage().maxRSS*1024,heapLimitBytes:getHeapStatistics().heap_size_limit,heapUsedBytes:process.memoryUsage().heapUsed}} }
  } catch (error) { response = { type: 'failure', message: error instanceof CurrentWorkbookLimitError ? error.message : '当前名录导出执行失败；请核对数据或资源限制后重新提交' } }
  finally { db?.close() }
  // Report the business result before bounded logging shutdown so a drain fault
  // cannot turn completed work into the supervisor's execution timeout.
  process.send?.(response)
  await closeApplicationLogging().catch(() => {})
  process.disconnect?.()
})
