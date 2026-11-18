import { defineEventHandler, readBody, getQuery, createError, setResponseStatus, setHeader } from 'h3'
import { useRuntimeConfig } from '#imports'
import { useDb } from '@db'
import type { CurrentTitle } from '../../lib/roster/current-qualification'
import { requireTaskCenterAccess } from '../../layers/core/server/utils/task-center-access'
import { ensureJobRunnerReady, getJobSpec, submitJob } from '../../layers/core/server/utils/job-runner'
import { registerJobSpecs } from './job-specs'
import { appLog, requestLogContext } from '../../layers/core/lib/logging'
/** Dedicated routes fix the title; only their OpenAPI descriptions differ. */
export function currentExportRoute(titleCode: CurrentTitle) {
  return defineEventHandler(async event => {
    const logContext = requestLogContext(event)
    let operation = 'export.current.submission'
    try {
    requireTaskCenterAccess(event)
    registerJobSpecs()
    const db = useDb(); ensureJobRunnerReady(db)
    const body = await readBody(event).catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || 'titleCode' in body || Object.keys(getQuery(event)).length) throw createError({statusCode:400,message:'需要JSON对象；不接收称号覆盖或日期参数'})
    const parsed = getJobSpec('current-roster-export')!.parse({...body,titleCode})
    if (!parsed.ok) throw createError({statusCode:400,message:parsed.message})
    if (parsed.params.regenerateOf) operation = 'export.current.regenerate'
    const input = {kind:'current-roster-export',params:parsed.params,filesDir:useRuntimeConfig(event).filesDir,logContext}
    const job = submitJob(db,input)
    appLog({ module: 'sme-roster', source: 'export', operation, outcome: 'success', taskId: job.id, ...(parsed.params.regenerateOf ? { resourceType: 'export_job', resourceId: String(parsed.params.regenerateOf) } : {}) }, logContext)
    setResponseStatus(event,202); setHeader(event,'location',`/api/jobs/${job.id}`)
    return {jobId:job.id,kind:job.kind,state:job.state}
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode
      appLog({ module: 'sme-roster', source: 'export', operation, outcome: status && status < 500 ? 'denied' : 'failure', level: status && status < 500 ? 'warn' : 'error', statusCode: status ?? 500, errorCode: status === 401 ? 'export_access_denied' : status === 429 ? 'export_capacity' : status === 409 ? 'export_conflict' : status === 400 ? 'invalid_export_request' : 'export_submission_failed' }, logContext)
      throw error
    }
  })
}
