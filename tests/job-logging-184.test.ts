import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../db/client'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../lib/logging'
import { __resetJobRunner, clearJobSpecs, registerJob, submitJob, whenIdle } from '../server/utils/job-runner'
import { getJob } from '../server/utils/job-store'
const dir = mkdtempSync(join(tmpdir(), 'jobs184-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'fixture.db') })
const previous = process.env.NUXT_LOG_DIR
beforeAll(() => { process.env.NUXT_LOG_DIR = join(dir, 'logs'); initializeWorkerLogging() })
afterAll(async () => { await whenIdle(); __resetJobRunner(); clearJobSpecs(); await closeApplicationLogging(); db.$client.close(); if (previous === undefined) delete process.env.NUXT_LOG_DIR; else process.env.NUXT_LOG_DIR=previous; rmSync(dir,{recursive:true,force:true}) })
it('retains submission context after return and logs one terminal with bounded progress and no payload', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release=resolve })
  const context = { requestId:'request184',traceId:'trace184' }
  let captured: unknown
  registerJob({ kind:'logging184',status:'ready',summary:'fixture',parse:params=>({ok:true,params}),run:async ctx=>{
    captured=ctx.logContext
    await gate
    for(let i=0;i<100;i++) ctx.progress(i,100)
    return {result:{private:'PRIVATE184_RESULT'},progress:{done:100,total:100}}
  } })
  const job=submitJob(db,{kind:'logging184',params:{private:'PRIVATE184_PARAMS'},filesDir:dir,logContext:context})
  context.requestId='mutated184'
  release(); await whenIdle(); await applicationLogs().flush()
  expect(getJob(db,job.id)).toMatchObject({state:'done',result:{private:'PRIVATE184_RESULT'}})
  expect(captured).toEqual({requestId:'request184',traceId:'trace184',taskId:job.id})
  const {rows}=await applicationLogs().list({taskId:job.id})
  expect(rows.filter(r=>r.operation==='task.finished')).toHaveLength(1)
  expect(rows.map(r=>r.operation)).toEqual(['task.finished','task.progress','task.started','task.queued'])
  expect(rows.every(r=>r.requestId==='request184' && r.traceId==='trace184')).toBe(true)
  const details=await Promise.all(rows.map(r=>applicationLogs().detail(r.id)))
  expect(details.find(r=>r?.operation==='task.finished')?.counts).toEqual({done:100,total:100})
  expect(JSON.stringify(details)).not.toMatch(/PRIVATE184|params|filesDir|mutated184/)
})

it('cancel retry recovery and duplicate finalization retain business checkpoints and unique terminals', async () => {
  const { requestJobCancel, requeueFinishedJob, ensureJobRunnerReady } = await import('../server/utils/job-runner')
  const { createJob, finishJob, setJobResult } = await import('../server/utils/job-store')
  let release!: () => void
  const gate=new Promise<void>(resolve=>{release=resolve})
  registerJob({kind:'cancel184',status:'ready',summary:'fixture',parse:params=>({ok:true,params}),run:async ctx=>{
    setJobResult(db,ctx.jobId,{checkpoint:'kept184'})
    await gate
    return {result:{checkpoint:'kept184'},cancelled:ctx.cancelled()}
  }})
  const active=submitJob(db,{kind:'cancel184',params:{},filesDir:dir,logContext:{requestId:'cancel184'}})
  const queued=submitJob(db,{kind:'cancel184',params:{},filesDir:dir,logContext:{requestId:'queued184'}})
  expect(requestJobCancel(db,queued.id)).toMatchObject({state:'cancelled',cancelled:true})
  expect(requestJobCancel(db,queued.id)).toMatchObject({alreadyFinished:true})
  expect(requestJobCancel(db,active.id)).toMatchObject({state:'running',cancelRequested:true})
  requestJobCancel(db,active.id)
  release(); await whenIdle()
  expect(getJob(db,active.id)).toMatchObject({state:'cancelled',result:{checkpoint:'kept184'}})
  finishJob(db,active.id,{state:'done',result:null})
  expect(getJob(db,active.id)?.state).toBe('cancelled')
  expect(requeueFinishedJob(db,{id:active.id,kind:'cancel184',params:{},filesDir:dir,logContext:{requestId:'retry184'}})).toBe(true)
  await whenIdle()
  expect(getJob(db,active.id)?.state).toBe('done')
  const interrupted=createJob(db,{id:'interrupted184',kind:'fixture184',params:{private:'PRIVATE184_RECOVER'}})
  expect(ensureJobRunnerReady(db)).toBe(1)
  expect(ensureJobRunnerReady(db)).toBe(0)
  expect(getJob(db,interrupted.id)?.state).toBe('failed')
  await applicationLogs().flush()
  const a=(await applicationLogs().list({taskId:active.id})).rows
  expect(a.filter(r=>r.operation==='task.finished').map(r=>[r.outcome,r.requestId])).toEqual([['success','retry184'],['cancelled','cancel184']])
  const q=(await applicationLogs().list({taskId:queued.id})).rows
  expect(q.filter(r=>r.operation==='task.finished')).toHaveLength(1)
  expect(q.find(r=>r.operation==='task.finished')?.requestId).toBe('queued184')
  const recovered=(await applicationLogs().list({taskId:interrupted.id})).rows
  expect(recovered.filter(r=>r.operation==='task.recovered')).toMatchObject([{outcome:'unknown'}])
  expect(recovered.filter(r=>r.operation==='task.finished')).toMatchObject([{outcome:'failure'}])
  expect(recovered.every(r=>!r.requestId)).toBe(true)
})
it('runner failure and idempotent resubmission preserve result and do not duplicate lifecycle',async()=>{
 const { setJobResult }=await import('../server/utils/job-store')
 registerJob({kind:'failure184',status:'ready',summary:'fixture',deduplicateRequest:true,parse:params=>({ok:true,params}),run:async ctx=>{
  setJobResult(db,ctx.jobId,{retained:1})
  throw new Error('PRIVATE184_THROW')
 }})
 const first=submitJob(db,{kind:'failure184',params:{clientRequestId:'idempotent184'},filesDir:dir,logContext:{requestId:'failure184'}})
 await whenIdle()
 const replay=submitJob(db,{kind:'failure184',params:{clientRequestId:'idempotent184'},filesDir:dir,logContext:{requestId:'replayed184'}})
 expect(replay.id).toBe(first.id)
 expect(getJob(db,first.id)).toMatchObject({state:'failed',result:{retained:1},error:'PRIVATE184_THROW'})
 await applicationLogs().flush()
 const rows=(await applicationLogs().list({taskId:first.id})).rows
 expect(rows.map(r=>r.operation)).toEqual(['task.finished','task.started','task.queued'])
 expect(rows[0]).toMatchObject({outcome:'failure',requestId:'failure184'})
 const detail=await applicationLogs().detail(rows[0]!.id)
 expect(detail?.errorCode).toBe('job_failed')
 expect(JSON.stringify(detail)).not.toContain('PRIVATE184')
})
