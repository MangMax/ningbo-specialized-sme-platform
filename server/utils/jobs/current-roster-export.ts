import { captureReceiptRuntimeContext } from '../receipt-runtime-context'
import { mkdir, rm, rename, stat, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CURRENT_RULE_VERSION, CURRENT_TITLES } from '../../../lib/roster/current-qualification'
import { isJobId } from '../../../layers/core/lib/job'
import type { JobSpec } from '../../../layers/core/server/utils/job-runner'
import { setJobResult } from '../../../layers/core/server/utils/job-store'
import { createCurrentExportWorker } from '../current-export-worker-location'
import { cleanupCurrentExports, currentExportDbPath, exportDirectory, EXPORT_RETENTION_MS } from '../current-export-artifact'
import { appLog } from '../../../layers/core/lib/logging'
const paramsSchema = z.strictObject({ titleCode: z.enum(CURRENT_TITLES), clientRequestId: z.string().trim().min(1).max(128), regenerateOf: z.string().refine(isJobId).optional() })
export const currentRosterExportSpec: JobSpec = {
  kind: 'current-roster-export', maxPending: 9, deduplicateRequest: true, status: 'ready', summary: '当前有效名录 Excel（后台独立进程）',
  paramsHint: '{ titleCode: little_giant|specialized_sme|innovative_sme, clientRequestId: string, regenerateOf?: jobId }；保留7天；同请求标识去重',
  parse(raw) { const parsed = paramsSchema.safeParse(raw); return parsed.success ? {ok:true, params:parsed.data} : {ok:false,message:'需要有效 titleCode、clientRequestId；不接受日期或额外参数'} },
  async run(ctx, params) {
    const logContext = { ...ctx.logContext, taskId: ctx.jobId }
    const dbPath = currentExportDbPath(ctx.db)
    if (!dbPath || dbPath === ':memory:') throw new Error('导出需要持久 SQLite 数据库')
    const dir = exportDirectory(dbPath), temporaryPath = join(dir,ctx.jobId + '.part'), finalPath = join(dir,ctx.jobId + '.xlsx')
    let worker: ReturnType<typeof createCurrentExportWorker> | undefined
    let workerExited: Promise<void> | undefined
    let cancelled = false, published = false, timedOut = false, processUnknown = false, processSettled = false, publishStarted = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const snapshotStartedAt = new Date().toISOString()
    let checkpoint: Record<string,unknown> = {phase:'starting', executionStartedAt:snapshotStartedAt, ruleVersion:CURRENT_RULE_VERSION}
    setJobResult(ctx.db,ctx.jobId,checkpoint)
    try {
      await cleanupCurrentExports(ctx.db, logContext)
      await mkdir(dir,{ recursive:true, mode:0o700 })
      const receiptRuntime = captureReceiptRuntimeContext(typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined)
      worker = createCurrentExportWorker()
      workerExited = new Promise(resolve => worker!.once('exit', () => resolve()))
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.process', outcome: 'started' }, logContext)
      const result = await new Promise<any>((resolve,reject) => {
        worker!.on('message', message => {
          if (message.type === 'progress') { ctx.progress(message.done,message.total); checkpoint={phase:'workbook',snapshotStartedAt:message.snapshotStartedAt,snapshotId:ctx.jobId,ruleVersion:CURRENT_RULE_VERSION}; setJobResult(ctx.db,ctx.jobId,checkpoint) }
          if (message.type === 'done') { processSettled = true; if (timeout) clearTimeout(timeout); resolve(message.result) }
          if (message.type === 'failure') { processSettled = true; if (timeout) clearTimeout(timeout); reject(new Error(message.message)) }
        })
        timeout = setTimeout(() => { timedOut = true; reject(new Error('导出超过10分钟执行预算，请缩减数据或检查资源后重新提交')) },10*60*1000)
        worker!.once('error', error => { if (!processSettled) { processUnknown = true; reject(error) } })
        worker!.once('exit',() => { if (!processSettled) { processUnknown = true; cancelled ? resolve(null) : reject(new Error('导出执行进程中断；请重新提交')) } })
        timer = setInterval(() => { if (ctx.cancelled()) { cancelled=true; void worker!.terminate() } },50)
        worker!.postMessage({dbPath, title:params.titleCode, temporaryPath,jobId:ctx.jobId,logContext,receiptRuntime})
      })
      if (cancelled || ctx.cancelled()) { appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.process', outcome: 'cancelled', errorCode: 'export_cancelled' }, logContext); return {cancelled:true,result:checkpoint} }
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.process', outcome: 'success' }, logContext)
      publishStarted = true
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.publish', outcome: 'started', resourceType: 'export_artifact', resourceId: ctx.jobId }, logContext)
      const sha = createHash('sha256')
      for await (const chunk of createReadStream(temporaryPath)) sha.update(chunk)
      if (ctx.cancelled()) { appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.publish', outcome: 'cancelled', errorCode: 'export_cancelled' }, logContext); return {cancelled:true,result:null} }
      const handle=await open(temporaryPath,'r');try {await handle.sync()} finally {await handle.close()}
      await rename(temporaryPath,finalPath)
      const directory=await open(dir,'r');try {await directory.sync()} finally {await directory.close()}
      const artifact = { id:ctx.jobId,filename:`current-${String(params.titleCode)}.xlsx`,size:(await stat(finalPath)).size,sha256:sha.digest('hex'),generatedAt:result.generatedAt,expiresAt:new Date(Date.now()+EXPORT_RETENTION_MS).toISOString(),downloadUrl:`/api/job-artifacts/${ctx.jobId}`,availability:'available' }
      published=true
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.publish', outcome: 'success', resourceType: 'export_artifact', resourceId: ctx.jobId }, logContext)
      return {result:{...result,phase:'complete',snapshotId:ctx.jobId,artifact},progress:{done:result.total,total:result.total}}
    } catch (error) {
      appLog({ module: 'sme-roster', source: 'export', operation: publishStarted ? 'export.current.publish' : 'export.current.process', outcome: timedOut ? 'timeout' : processUnknown ? 'unknown' : 'failure', level: 'error', errorCode: timedOut ? 'export_timeout' : processUnknown ? 'export_process_interrupted' : publishStarted ? 'artifact_publish_failed' : 'export_execution_failed' }, logContext)
      const message=error instanceof Error ? error.message : ''
      return {result:checkpoint,error:/^(导出|当前名录|Excel)/.test(message) ? message : '导出失败；请检查数据和可写产物存储后重新提交'}
    } finally {
      if (timer) clearInterval(timer); if(timeout) clearTimeout(timeout)
      // A completed worker drains at shutdown. Keep it alive for that bounded
      // window; cancellation/timeout still use the original forced termination.
      if (processSettled && workerExited) {
        let shutdownTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([workerExited, new Promise<void>(resolve => { shutdownTimer = setTimeout(resolve, 3500) })])
        if (shutdownTimer) clearTimeout(shutdownTimer)
      }
      await worker?.terminate()
      let failed = 0
      await rm(temporaryPath,{force:true}).catch(() => { failed++ })
      if(!published) await rm(finalPath,{force:true}).catch(() => { failed++ })
      appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.cleanup', outcome: failed ? 'failure' : 'success', level: failed ? 'error' : 'info', ...(failed ? { errorCode: 'artifact_cleanup_failed' } : {}), counts: { failed }, resourceType: 'export_artifact', resourceId: ctx.jobId }, logContext)
    }
  },
}
