import { defineEventHandler, readBody, getQuery, createError, setResponseStatus, setHeader } from 'h3'
import { useRuntimeConfig } from '#imports'
import { useDb } from '@db'
import type { CurrentTitle } from '../../lib/roster/current-qualification'
import { requireTaskCenterAccess } from './task-center-access'
import { ensureJobRunnerReady, getJobSpec, submitJob } from './job-runner'
import { registerJobSpecs } from './job-specs'
/** Dedicated routes fix the title; only their OpenAPI descriptions differ. */
export function currentExportRoute(titleCode: CurrentTitle) {
  return defineEventHandler(async event => {
    requireTaskCenterAccess(event)
    registerJobSpecs()
    const db = useDb(); ensureJobRunnerReady(db)
    const body = await readBody(event).catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || 'titleCode' in body || Object.keys(getQuery(event)).length) throw createError({statusCode:400,message:'需要JSON对象；不接收称号覆盖或日期参数'})
    const parsed = getJobSpec('current-roster-export')!.parse({...body,titleCode})
    if (!parsed.ok) throw createError({statusCode:400,message:parsed.message})
    const job = submitJob(db,{kind:'current-roster-export',params:parsed.params,filesDir:useRuntimeConfig(event).filesDir})
    setResponseStatus(event,202); setHeader(event,'location',`/api/jobs/${job.id}`)
    return {jobId:job.id,kind:job.kind,state:job.state}
  })
}
