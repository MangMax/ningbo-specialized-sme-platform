import type { JobSpec, PostgresJobSpec } from '../../../../core/server/public'
import { getJob } from '../../../../core/server/utils/job-store-postgres'
import { readPostgresExportSummaries } from './export-summary-postgres'
import { mkdir, rm, rename, stat, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CURRENT_RULE_VERSION, CURRENT_TITLES } from '../../../lib/roster/current-qualification-model'
import { isJobId, isTerminalJobState } from '../../../../core/lib/job'
import type { JobRow } from '../../../../core/server/utils/job-contract'
import { createCurrentExportWorker } from '../current-export-worker-location'
import { captureReceiptRuntimeContext } from '../receipt-runtime-context'
import type { CurrentExportResponse, CurrentExportRequest } from '../../../lib/roster/current-export-worker'
import { cleanupExportArtifacts, currentArtifact, EXPORT_RETENTION_MS, postgresExportDirectory } from '../current-export-artifact'
import { appLog, type LogContext } from '../../../../core/lib/logging'
const paramsSchema = z.strictObject({ titleCode: z.enum(CURRENT_TITLES), clientRequestId: z.string().trim().min(1).max(128), regenerateOf: z.string().refine(isJobId).optional() })
interface CurrentExportExecution {
  jobId: string
  logContext?: Readonly<LogContext>
  progress(done: number, total: number): void | Promise<void>
  checkpoint(value: unknown): void | Promise<void>
  cancelled(): boolean | Promise<boolean>
  cleanup(context: LogContext): Promise<void>
}

async function runCurrentExport(dir: string, options: CurrentExportExecution, title: CurrentExportRequest['title']) {
  const logContext = { ...options.logContext, taskId: options.jobId }
  const temporaryPath = join(dir,options.jobId + '.part'), finalPath = join(dir,options.jobId + '.xlsx')
  let worker: ReturnType<typeof createCurrentExportWorker> | undefined
  let workerExited: Promise<void> | undefined
  let cancelled = false, published = false, timedOut = false, processUnknown = false, processSettled = false, publishStarted = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let progressWrites = Promise.resolve()
  let cancellationCheck: Promise<void> | undefined
  const snapshotStartedAt = new Date().toISOString()
  let checkpoint: Record<string,unknown> = {phase:'starting', executionStartedAt:snapshotStartedAt, ruleVersion:CURRENT_RULE_VERSION}
  await options.checkpoint(checkpoint)
  try {
    await options.cleanup(logContext)
    await mkdir(dir,{ recursive:true, mode:0o700 })
    const receiptRuntime = captureReceiptRuntimeContext(typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined)
    worker = createCurrentExportWorker()
    workerExited = new Promise(resolve => worker!.once('exit', () => resolve()))
    appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.process', outcome: 'started' }, logContext)
    const result = await new Promise<Extract<CurrentExportResponse, { type: 'done' }>['result'] | null>((resolve,reject) => {
      worker!.on('message', (message: CurrentExportResponse) => {
        if (message.type === 'progress') {
          progressWrites = progressWrites.then(async () => {
            await options.progress(message.done, message.total)
            checkpoint = { phase: 'workbook', snapshotStartedAt: message.snapshotStartedAt, snapshotId: options.jobId, ruleVersion: CURRENT_RULE_VERSION }
            await options.checkpoint(checkpoint)
          })
          void progressWrites.catch(reject)
        }
        if (message.type === 'done') {
          processSettled = true
          if (timeout) clearTimeout(timeout)
          void progressWrites.then(() => resolve(message.result), reject)
        }
        if (message.type === 'failure') { processSettled = true; if (timeout) clearTimeout(timeout); reject(new Error(message.message)) }
      })
      timeout = setTimeout(() => { timedOut = true; reject(new Error('导出超过10分钟执行预算，请缩减数据或检查资源后重新提交')) },10*60*1000)
      worker!.once('error', error => { if (!processSettled) { processUnknown = true; reject(error) } })
      worker!.once('exit',() => { if (!processSettled) { processUnknown = true; cancelled ? resolve(null) : reject(new Error('导出执行进程中断；请重新提交')) } })
      timer = setInterval(() => {
        if (cancellationCheck || processSettled || cancelled) return
        cancellationCheck = Promise.resolve().then(() => options.cancelled()).then(requested => {
          if (requested) {
            cancelled = true
            void worker!.terminate()
          }
        }).catch(reject).finally(() => { cancellationCheck = undefined })
      }, 50)
      worker!.postMessage({ title, temporaryPath, jobId: options.jobId, logContext, receiptRuntime } satisfies CurrentExportRequest)
    })
    if (!result || cancelled || await options.cancelled()) { appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.process', outcome: 'cancelled', errorCode: 'export_cancelled' }, logContext); return {cancelled:true,result:checkpoint} }
    appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.process', outcome: 'success' }, logContext)
    publishStarted = true
    appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.publish', outcome: 'started', resourceType: 'export_artifact', resourceId: options.jobId }, logContext)
    const sha = createHash('sha256')
    for await (const chunk of createReadStream(temporaryPath)) sha.update(chunk)
    if (await options.cancelled()) { appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.publish', outcome: 'cancelled', errorCode: 'export_cancelled' }, logContext); return {cancelled:true,result:null} }
    const handle=await open(temporaryPath,'r');try {await handle.sync()} finally {await handle.close()}
    await rename(temporaryPath,finalPath)
    const directory=await open(dir,'r');try {await directory.sync()} finally {await directory.close()}
    const artifact = { id:options.jobId,filename:`current-${title}.xlsx`,size:(await stat(finalPath)).size,sha256:sha.digest('hex'),generatedAt:result.generatedAt,expiresAt:new Date(Date.now()+EXPORT_RETENTION_MS).toISOString(),downloadUrl:`/api/job-artifacts/${options.jobId}`,availability:'available' }
    published=true
    appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.publish', outcome: 'success', resourceType: 'export_artifact', resourceId: options.jobId }, logContext)
    return {result:{...result,phase:'complete',snapshotId:options.jobId,artifact},progress:{done:result.total,total:result.total}}
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
    await cancellationCheck
    await progressWrites.catch(() => {})
    let failed = 0
    await rm(temporaryPath,{force:true}).catch(() => { failed++ })
    if(!published) await rm(finalPath,{force:true}).catch(() => { failed++ })
    appLog({ module: 'sme-roster', source: 'export', operation: 'export.current.cleanup', outcome: failed ? 'failure' : 'success', level: failed ? 'error' : 'info', ...(failed ? { errorCode: 'artifact_cleanup_failed' } : {}), counts: { failed }, resourceType: 'export_artifact', resourceId: options.jobId }, logContext)
  }
}

function validateRegeneration(titleCode: unknown, prior: JobRow | null | undefined) {
  if (prior?.kind !== 'current-roster-export' || prior.params.titleCode !== titleCode || !isTerminalJobState(prior.state)) {
    throw Object.assign(new Error('重新生成需要同称号已结束任务'), { statusCode: 409 })
  }
}

const postgresExport: PostgresJobSpec = {
  async validateSubmission(tx, params) {
    if (!postgresExportDirectory()) {
      throw Object.assign(new Error('需要配置 NUXT_ROSTER_EXPORT_DIR'), { statusCode: 503 })
    }
    if (params.regenerateOf) validateRegeneration(params.titleCode, (await getJob(tx, String(params.regenerateOf)))?.row)
  },
  allowBrowserCancel: true,
  taskCenter: { summaries: readPostgresExportSummaries },
  async run(ctx, params) {
    const directory = postgresExportDirectory()
    if (!directory) return { result: null, error: '需要配置 NUXT_ROSTER_EXPORT_DIR' }
    const titleCode = paramsSchema.shape.titleCode.parse(params.titleCode)
    return runCurrentExport(directory, {
      ...ctx,
      cleanup: context => cleanupExportArtifacts(directory, async id => (await getJob(ctx.db, id))?.row, context),
    }, titleCode)
  },
  async projectResult(_db, job) {
    const artifact = await currentArtifact(job, postgresExportDirectory())
    return artifact ? { ...(job.result as object), artifact } : job.result
  },
}

export const currentRosterExportSpec: JobSpec = {
  openAPIParams: {
    order: 10,
    description: 'current-roster-export 使用 { titleCode: little_giant|specialized_sme|innovative_sme, clientRequestId: string, regenerateOf?: jobId }；运行/排队最多9个，独立进程生成，产物保留7天。',
  },
  kind: 'current-roster-export', maxPending: 9, deduplicateRequest: true, status: 'ready', summary: '当前有效名录 Excel（后台独立进程）',
  paramsHint: '{ titleCode: little_giant|specialized_sme|innovative_sme, clientRequestId: string, regenerateOf?: jobId }；保留7天；同请求标识去重',
  parse(raw) { const parsed = paramsSchema.safeParse(raw); return parsed.success ? {ok:true, params:parsed.data} : {ok:false,message:'需要有效 titleCode、clientRequestId；不接受日期或额外参数'} },
  postgres: postgresExport,
}
