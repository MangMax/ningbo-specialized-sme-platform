import { getHeapStatistics } from 'node:v8'
import Database from 'better-sqlite3'
import { CurrentWorkbookLimitError, writeCurrentWorkbook } from './current-workbook'
import { CURRENT_RULE_VERSION, type CurrentTitle } from './current-qualification'
process.on('disconnect', () => process.exit(1))
process.once('message', async (request: { dbPath: string; title: CurrentTitle; temporaryPath: string; jobId: string }) => {
  let db: Database.Database | undefined
  try {
    db = new Database(request.dbPath, { readonly: true, fileMustExist: true })
    const result = await writeCurrentWorkbook(db, request.title, request.temporaryPath, (done,total,snapshotStartedAt) => process.send?.({ type: 'progress', done,total,snapshotStartedAt,snapshotId:request.jobId,ruleVersion:CURRENT_RULE_VERSION }))
    process.send?.({ type: 'done', result: {...result,executor:{peakRssBytes:process.resourceUsage().maxRSS*1024,heapLimitBytes:getHeapStatistics().heap_size_limit,heapUsedBytes:process.memoryUsage().heapUsed}} })
  } catch (error) { process.send?.({ type: 'failure', message: error instanceof CurrentWorkbookLimitError ? error.message : '当前名录导出执行失败；请核对数据或资源限制后重新提交' }) }
  finally { db?.close(); process.disconnect?.() }
})
