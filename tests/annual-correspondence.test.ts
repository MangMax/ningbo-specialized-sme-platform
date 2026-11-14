import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { useDb, schema as s } from '../db/client'
import { annualHash, qualifyAnnualFinal, reconcileAnnualStep, type AnnualScopeReader, type AnnualWriteScope } from '../server/utils/annual-correspondence'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceRequest } from '../server/utils/record-correspondence'
import { activateAnnualCorrespondence, initializeAnnualCorrespondenceRunner, stageAnnualCorrespondence, submitAnnualCorrespondence, retryAnnualCorrespondence } from '../server/utils/jobs/annual-correspondence'
import { __resetJobRunner, clearJobSpecs, ensureJobRunnerReady, requestJobCancel, whenIdle } from '../server/utils/job-runner'
import { getJob } from '../server/utils/job-store'
import { dispatchAnnualTaskMcp, handleAnnualTaskRequest, readAnnualTask } from '../server/utils/annual-correspondence-api'
const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'annual-251-')); dirs.push(dir)
  const db = useDb({dbPath:join(dir,'synthetic.db')})
  __resetJobRunner(); clearJobSpecs(); ensureJobRunnerReady(db)
  const enterprise = db.insert(s.enterprise).values({name:'合成年度企业',nameNorm:'合成年度企业',usccNorm:'91330211255994457P'}).returning().get()
  const record = db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',usccRaw:enterprise.usccNorm}).returning().get()
  const event = db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2022}).returning().get()
  const query = db.insert(s.platformQuery).values({interface:'business_list',queryKey:enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-18T00:00:00Z',status:'success',rawResponse:'original archive'}).returning().get()
  const add = (key:string, status='终审通过') => db.insert(s.platformRelation).values({queryId:query.id,sequenceNo:db.select().from(s.platformRelation).all().length+1,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm,relationKey:key,year:2022,declareKind:'apply',status,verificationStatus:'confirmed',rawFields:{original:'unchanged'}}).returning().get()
  const early = add('early','终审不通过'), late = add('late')
  let final = 'late', excludePreferred = false
  // This port fixture models the already-scoped #250 seam only. Domain writes,
  // source validation, auditing and job scheduling below are actual SQLite.
  const read: AnnualScopeReader = (database,id) => {
    if (id !== event.id) return null
    const relations = database.select().from(s.platformRelation).all()
    const sourceRefs = {event:database.select().from(s.recordEvent).where(eq(s.recordEvent.id,id)).get(),query:database.select().from(s.platformQuery).where(eq(s.platformQuery.id,query.id)).get(),relations}
    const steps = [...Map.groupBy(relations,r=>r.relationKey!).entries()].map(([stepId,rs])=>({stepId,currentRelationIds:rs.map(r=>r.id),protectionRelationIds:rs.map(r=>r.id),preferredRelationId:excludePreferred?null:rs[0]!.id,eligible:true,reasons:[]}))
    return {eventId:id,enterpriseId:enterprise.id,titleCode:record.titleCode,declareKind:'apply',generation:annualHash(sourceRefs),sourceRefs,steps,finalCandidateStepId:final||null,reasons:final?[]:['latest_status_not_terminal']}
  }
  const scope = ()=>read(db,event.id)!
  const reconcile = (stepId='late')=>reconcileAnnualStep(db,read,{eventId:event.id,generation:scope().generation,stepId})
  const save = (request:CorrespondenceRequest)=>{const plan=preflightRecordCorrespondences(db,request);return commitRecordCorrespondences(db,request,plan.planHash)}
  const manual = (key:string,operations:CorrespondenceRequest['operations'])=>save({idempotencyKey:key,sourceIdentity:'synthetic/'+key,actor:{type:'user',id:'synthetic-reviewer'},basis:'synthetic explicit decision',ruleId:'manual',ruleVersion:'1',operations})
  const rows = ()=>db.select().from(s.recordCorrespondence).all()
  const audits = ()=>db.select().from(s.recordCorrespondenceAudit).all()
  return {db,dir,event,query,early,late,add,scope,read,reconcile,save,manual,rows,audits,setFinal:(id:string)=>{final=id},excludePreferred:()=>{excludePreferred=true}}
}
afterEach(async()=>{await whenIdle();__resetJobRunner();clearJobSpecs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
it('commits early failed and late passed process edges with one qualified final and unchanged source facts',()=>{
 const f=fixture(), before=f.scope().sourceRefs
 expect(qualifyAnnualFinal(f.db,f.scope()).status).toBe('eligible')
 const early=f.reconcile('early'),late=f.reconcile()
 expect([early.status,late.status]).toEqual(['created','created'])
 expect(f.rows().map(r=>[r.role,r.status,r.relationId])).toEqual([['context_only','confirmed',f.early.id],['context_only','confirmed',f.late.id]])
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({stepId:'late',status:'confirmed',decisionRefs:[{relationId:f.late.id,requiresRevalidation:false}]})
 expect(f.scope().sourceRefs).toEqual(before)
 expect(f.audits()).toHaveLength(4)
 expect(JSON.parse(f.audits()[3]!.basis)).toMatchObject({generation:f.scope().generation,selectedRelationId:f.late.id,sourceRefs:before})
})
it('replays a committed business without duplicate audit and names the actual decided observation',()=>{
 const f=fixture(); const first=f.reconcile(); const audit=f.audits();const row=f.rows()[0]
 expect(f.reconcile()).toMatchObject({status:'existing',relationId:f.late.id,decisionRefs:first.decisionRefs})
 expect(f.audits()).toEqual(audit);expect(f.rows()).toEqual([row])
 const duplicate=f.add('late')
 expect(f.reconcile()).toMatchObject({status:'existing',decisionRefs:[{relationId:f.late.id}]})
 expect(f.rows().some(r=>r.relationId===duplicate.id)).toBe(false)
})
it.each([{name:'rejected',status:'rejected' as const},{name:'unlinked',status:'unlinked' as const}])('preserves manual $name across a new generation',({status})=>{
 const f=fixture();const id=f.manual('manual-candidate',[{action:'create',status:status==='rejected'?'rejected':'confirmed',edge:{type:'event_process',eventId:f.event.id,relationId:f.late.id,role:'supports_award'}}]).correspondenceIds[0]!
 if(status==='unlinked')f.manual('manual-unlink',[{action:'decide',correspondenceId:id,expectedRevision:2,status:'unlinked'}])
 const before=f.audits(); f.add('late')
 expect(f.reconcile()).toMatchObject({status:'protected',decisionRefs:[{id,status}]})
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({stepId:null,status:'blocked',reasons:['protected_decision']})
 expect(f.audits()).toEqual(before)
})
it('preserves manual reselection and does not silently revive the original edge',()=>{
 const f=fixture();const created=f.reconcile(); const id=created.decisionRefs[0]!.id
 f.manual('manual-reselect',[{action:'correct',correspondenceId:id,expectedRevision:2,edge:{type:'event_process',eventId:f.event.id,relationId:f.early.id,role:'context_only'}}])
 const audit=f.audits();expect(f.reconcile().status).toBe('protected');expect(f.audits()).toEqual(audit)
})
it('uses expected revision to confirm a current candidate while keeping its original source fingerprint',()=>{
 const f=fixture();const id=f.manual('candidate',[{action:'create',status:'candidate',edge:{type:'event_process',eventId:f.event.id,relationId:f.late.id,role:'context_only'}}]).correspondenceIds[0]!
 const before=f.rows()[0]!
 expect(f.reconcile()).toMatchObject({status:'created',decisionRefs:[{id,revision:2,status:'confirmed'}]})
 expect(f.rows()[0]!.sourceFingerprint).toBe(before.sourceFingerprint)
 expect(f.audits().at(-1)).toMatchObject({expectedRevision:1,resultingRevision:2})
})
it('blocks stale source decisions and old-generation final without mutating history',()=>{
 const f=fixture(),old=f.scope();f.reconcile();const audit=f.audits(),row=f.rows()[0]!
 f.db.update(s.platformQuery).set({rawResponse:'changed source'}).where(eq(s.platformQuery.id,f.query.id)).run()
 expect(f.reconcile()).toMatchObject({status:'needs_review',reasons:['source_requires_revalidation']})
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({status:'blocked',reasons:['source_requires_revalidation']})
 expect(qualifyAnnualFinal(f.db,f.scope(),old.generation)).toMatchObject({stepId:null,status:'blocked',reasons:['source_generation_changed']})
 expect(f.audits()).toEqual(audit);expect(f.rows()).toEqual([row])
})
it('retains core title validation and rolls back preflight ledger on a failing write',()=>{
 const f=fixture();f.db.update(s.platformQuery).set({rdjb:'1',titleCode:'innovative_sme'}).where(eq(s.platformQuery.id,f.query.id)).run()
 expect(()=>f.reconcile()).toThrowError(expect.objectContaining({code:'title_conflict'}))
 expect(f.rows()).toEqual([]);expect(f.db.select().from(s.importBatch).all()).toEqual([])
})
it('rejects a changed generation before preflight and bounds source materialization',()=>{
 const f=fixture(),generation=f.scope().generation;f.add('added')
 expect(()=>reconcileAnnualStep(f.db,f.read,{eventId:f.event.id,generation,stepId:'late'})).toThrowError(expect.objectContaining({code:'source_generation_changed'}))
 f.db.update(s.platformQuery).set({rawResponse:'x'.repeat(4*1024*1024)}).where(eq(s.platformQuery.id,f.query.id)).run()
 expect(()=>f.reconcile()).toThrowError(expect.objectContaining({code:'source_materialization_limit'}))
 expect(f.rows()).toEqual([]);expect(f.db.select().from(s.importBatch).all()).toEqual([])
})
it('does not fall back to an earlier confirmed pass when annual facts have no final candidate',()=>{
 const f=fixture();f.reconcile('early');f.setFinal('')
 expect(qualifyAnnualFinal(f.db,f.scope())).toEqual({stepId:null,status:'none',decisionRefs:[],reasons:['latest_status_not_terminal']})
 f.excludePreferred(); expect(f.reconcile()).toMatchObject({status:'needs_review',reasons:['explicit_endpoint_required']})
})
it('atomically stages server generation identity and binds client keys to frozen inputs',async()=>{
 const f=fixture();const a=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'same-key',eventIds:[f.event.id]})
 expect(getJob(f.db,a.jobId)?.state).toBe('queued');expect(f.rows()).toEqual([])
 const b=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'new-refresh-key',eventIds:[f.event.id]})
 expect(b.jobId).toBe(a.jobId)
 expect(()=>stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'same-key',eventIds:[999]})).toThrowError(expect.objectContaining({code:'idempotency_conflict'}))
 activateAnnualCorrespondence(f.db,f.read,[a.jobId],f.dir);await whenIdle()
 expect(getJob(f.db,a.jobId)?.state).toBe('done');const audit=f.audits()
 expect(submitAnnualCorrespondence(f.db,f.read,{clientRequestId:'another-refresh',eventIds:[f.event.id]},f.dir).jobId).toBe(a.jobId)
 expect(f.audits()).toEqual(audit)
 f.add('additional');expect(stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'same-key',eventIds:[f.event.id]}).jobId).toBe(a.jobId)
 expect(stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'fresh-generation',eventIds:[f.event.id]}).jobId).not.toBe(a.jobId)
 expect(readAnnualTask(f.db,f.read,a.jobId,false)?.result?.events[0]?.finalQualification).toMatchObject({status:'blocked',reasons:['source_generation_changed']})
})
it('rolls staged task back with its containing archive transaction',()=>{
 const f=fixture();expect(()=>f.db.transaction(()=>{stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'rollback',eventIds:[f.event.id]});throw new Error('rollback')})).toThrow('rollback')
 expect(f.db.select().from(s.job).all()).toEqual([]);expect(f.audits()).toEqual([])
})
it('cancels queued work and resumes on the same durable job without duplicating decisions',async()=>{
 const f=fixture(); const a=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'cancel',eventIds:[f.event.id]})
 expect(requestJobCancel(f.db,a.jobId)).toMatchObject({state:'cancelled'})
 expect(f.rows()).toEqual([])
 retryAnnualCorrespondence(f.db,f.read,a.jobId,f.dir);await whenIdle()
 expect(getJob(f.db,a.jobId)?.state).toBe('done');expect(f.audits()).toHaveLength(4)
})
it('keeps per-event partial failure and only resumes unfinished work',async()=>{
 const f=fixture();const a=submitAnnualCorrespondence(f.db,f.read,{clientRequestId:'partial',eventIds:[f.event.id,999]},f.dir);await whenIdle()
 const result=getJob(f.db,a.jobId)!.result as any
 expect(getJob(f.db,a.jobId)?.state).toBe('failed');expect(result.events.map((e:any)=>e.status)).toEqual(['done','failed'])
 expect(result.events[1].errorCode).toBe('event_unavailable');const audit=f.audits()
 retryAnnualCorrespondence(f.db,f.read,a.jobId,f.dir);await whenIdle()
 expect(f.audits()).toEqual(audit);expect((getJob(f.db,a.jobId)!.result as any).attempt).toBe(2)
})
it('reads task state without ledger or job mutation and enforces independent REST and MCP authorization',async()=>{
 const f=fixture(), ctx={db:f.db,readScope:f.read,filesDir:f.dir,apiToken:'rest-secret'}
 const unauth=await handleAnnualTaskRequest('submit',{method:'POST',body:{clientRequestId:'deny',eventIds:[f.event.id]}},ctx)
 expect(unauth.status).toBe(401);expect(f.db.select().from(s.job).all()).toEqual([])
 expect(await dispatchAnnualTaskMcp('submit',{clientRequestId:'mcp-deny',eventIds:[f.event.id]},{...ctx,authorized:false})).toMatchObject({isError:true})
 const accepted=await dispatchAnnualTaskMcp('submit',{clientRequestId:'mcp-allow',eventIds:[f.event.id]},{...ctx,authorized:true}) as any
 await whenIdle();const before={jobs:f.db.select().from(s.job).all(),audit:f.audits(),batch:f.db.select().from(s.importBatch).all()}
 const get=await handleAnnualTaskRequest('detail',{method:'GET',id:accepted.jobId},ctx)
 expect(get.status).toBe(200);expect(get.headers['cache-control']).toBe('no-store');expect(get.body).toMatchObject({status:'done',capabilities:{cancel:false,retry:false},result:{events:[{finalQualification:{status:'confirmed'}}]}})
 expect({jobs:f.db.select().from(s.job).all(),audit:f.audits(),batch:f.db.select().from(s.importBatch).all()}).toEqual(before)
 expect(JSON.stringify(get.body)).not.toContain('rest-secret')
})
it('validates a new version independently and never propagates the old observation decision',()=>{
 const f=fixture();f.reconcile();const old=f.rows()[0]!,oldAudit=f.audits()
 const changed=f.add('late','终审不通过')
 const versionRead:AnnualScopeReader=(db,id)=>{const scope=f.read(db,id);if(!scope)return null;scope.steps.find(s=>s.stepId==='late')!.currentRelationIds=[changed.id];scope.steps.find(s=>s.stepId==='late')!.preferredRelationId=changed.id;return scope}
 expect(qualifyAnnualFinal(f.db,versionRead(f.db,f.event.id)!)).toMatchObject({status:'eligible',decisionRefs:[]})
 expect(reconcileAnnualStep(f.db,versionRead,{eventId:f.event.id,generation:f.scope().generation,stepId:'late'})).toMatchObject({status:'created',decisionRefs:[{relationId:changed.id}]})
 expect(f.rows()[0]).toEqual(old);expect(f.audits().slice(0,2)).toEqual(oldAudit);expect(f.rows()[1]!.sourceFingerprint).not.toBe(old.sourceFingerprint)
})
it('observes a manual rejection on another connection after admission before worker commit',async()=>{
 const f=fixture();const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'manual-race',eventIds:[f.event.id]})
 const concurrent=drizzle(new Database(join(f.dir,'synthetic.db')),{schema:s})
 const request:CorrespondenceRequest={idempotencyKey:'concurrent-manual',sourceIdentity:'synthetic/concurrent',actor:{type:'user',id:'other-reviewer'},basis:'explicit rejection before commit',ruleId:'manual',ruleVersion:'1',operations:[{action:'create',status:'rejected',edge:{type:'event_process',eventId:f.event.id,relationId:f.late.id,role:'supports_award'}}]}
 const plan=preflightRecordCorrespondences(concurrent,request);commitRecordCorrespondences(concurrent,request,plan.planHash);concurrent.$client.close()
 activateAnnualCorrespondence(f.db,f.read,[task.jobId],f.dir);await whenIdle()
 expect(f.rows().filter(r=>r.relationId===f.late.id).map(r=>r.status)).toEqual(['rejected'])
 expect((getJob(f.db,task.jobId)!.result as any).events[0]).toMatchObject({status:'done',outcomes:[{stepId:'early',status:'created'},{stepId:'late',status:'protected'}],finalQualification:{status:'blocked'}})
})
it('resumes after a process interruption between domain commit and step checkpoint',async()=>{
 const f=fixture();const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'crash-window',eventIds:[f.event.id]})
 f.reconcile('early');const oldAudit=f.audits()
 const {markJobRunning}=await import('../server/utils/job-store');markJobRunning(f.db,task.jobId)
 const restarted=drizzle(new Database(join(f.dir,'synthetic.db')),{schema:s});expect(initializeAnnualCorrespondenceRunner(restarted,f.read)).toBe(1)
 const beforeGet=getJob(restarted,task.jobId);const refreshed=await handleAnnualTaskRequest('detail',{method:'GET',id:task.jobId,headers:{authorization:'Bearer configured'}},{db:restarted,readScope:f.read,filesDir:f.dir,apiToken:'configured'})
 expect(refreshed.body).toMatchObject({status:'failed',capabilities:{retry:true}});expect(getJob(restarted,task.jobId)).toEqual(beforeGet)
 retryAnnualCorrespondence(restarted,f.read,task.jobId,f.dir);await whenIdle()
 expect(getJob(restarted,task.jobId)?.state).toBe('done')
 expect(f.audits().slice(0,2)).toEqual(oldAudit);expect(f.audits()).toHaveLength(4)
 expect((getJob(restarted,task.jobId)!.result as any).events[0].outcomes[0]).toMatchObject({stepId:'early',status:'existing',decisionRefs:[{relationId:f.early.id}]})
 restarted.$client.close()
})
it('stops between business checkpoints and retries the remaining business only',async()=>{
 const f=fixture();const task=submitAnnualCorrespondence(f.db,f.read,{clientRequestId:'partial-cancel',eventIds:[f.event.id]},f.dir)
 await new Promise<void>(resolve=>setImmediate(resolve))
 expect(f.rows()).toHaveLength(1);expect(requestJobCancel(f.db,task.jobId)).toMatchObject({state:'running',cancelRequested:true})
 await whenIdle();expect(getJob(f.db,task.jobId)?.state).toBe('cancelled')
 expect((getJob(f.db,task.jobId)!.result as any).events[0].outcomes).toHaveLength(1)
 const oldAudit=f.audits();retryAnnualCorrespondence(f.db,f.read,task.jobId,f.dir);await whenIdle()
 expect(getJob(f.db,task.jobId)?.state).toBe('done');expect(f.audits().slice(0,2)).toEqual(oldAudit);expect(f.audits()).toHaveLength(4)
})
it('fails an admitted stale generation and requires a fresh request instead of old continuation',async()=>{
 const f=fixture();const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'stale-stage',eventIds:[f.event.id]});f.add('added')
 activateAnnualCorrespondence(f.db,f.read,[task.jobId],f.dir);await whenIdle()
 expect(getJob(f.db,task.jobId)?.state).toBe('failed');expect((getJob(f.db,task.jobId)!.result as any).events[0].errorCode).toBe('source_generation_changed')
 expect(()=>retryAnnualCorrespondence(f.db,f.read,task.jobId,f.dir)).toThrowError(expect.objectContaining({code:'source_generation_changed'}))
 expect(f.rows()).toEqual([])
})
it('gates real HTTP browser commands by exact origin without exposing a token',async()=>{
 const {createServer}=await import('node:http');const {createApp,createRouter,toNodeListener}=await import('h3');const {annualTaskRoute}=await import('../server/utils/annual-correspondence-route')
 const f=fixture(),config={apiToken:'http-private-token',}
 const context=()=>({db:f.db,readScope:f.read,filesDir:f.dir,config})
 const router=createRouter();router.post('/events/:id/tasks',annualTaskRoute('submit',context,{eventScoped:true}));router.get('/tasks/:id',annualTaskRoute('detail',context));router.post('/tasks/:id/cancel',annualTaskRoute('cancel',context));router.post('/tasks/:id/retry',annualTaskRoute('retry',context))
 const app=createApp().use(router);const server=createServer(toNodeListener(app));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`
 const post=(origin:string|undefined,extra:Record<string,string>={},body:unknown={clientRequestId:'browser'})=>fetch(`${base}/events/${f.event.id}/tasks`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{}),...extra},body:JSON.stringify(body)})
 try {
  expect((await post('https://elsewhere.invalid')).status).toBe(403);expect((await post(undefined)).status).toBe(403)
  expect((await post(base,{'sec-fetch-site':'cross-site'})).status).toBe(403)
  expect((await post(base,{'content-type':'text/plain'})).status).toBe(415)
  expect(f.db.select().from(s.job).all()).toEqual([])
  expect((await post(base,{}, {clientRequestId:'forged',eventIds:[999]})).status).toBe(400)
  const response=await post(base);expect(response.status).toBe(202);const receipt=await response.json() as any;await whenIdle()
  const detail=await fetch(`${base}/tasks/${receipt.jobId}`);expect(detail.status).toBe(200);const dto=await detail.json() as any
  expect(dto).toMatchObject({status:'done',result:{events:[{eventId:f.event.id,finalQualification:{status:'confirmed'}}]}})
  expect(JSON.stringify({receipt,dto})).not.toContain(config.apiToken)
  expect((await post(undefined,{authorization:'Bearer http-private-token'},{clientRequestId:'rest-authorized'})).status).toBe(202)
  expect((await post(base,{authorization:'Bearer wrong'})).status).toBe(401)
 } finally {await whenIdle();await new Promise<void>(r=>server.close(()=>r()))}
})
it.each([{name:'empty',input:{clientRequestId:'bad',eventIds:[]}},{name:'too-many',input:{clientRequestId:'bad',eventIds:Array.from({length:201},(_,i)=>i+1)}},{name:'unsafe-id',input:{clientRequestId:'bad',eventIds:[Number.MAX_SAFE_INTEGER+1]}},{name:'unknown-field',input:{clientRequestId:'bad',eventIds:[1],sourceGeneration:'forged'}}])('rejects invalid admission partition $name before persistence',({input})=>{
 const f=fixture();expect(()=>stageAnnualCorrespondence(f.db,f.read,input)).toThrowError(expect.objectContaining({code:'invalid_annual_task_request'}));expect(f.db.select().from(s.job).all()).toEqual([])
})
it('retains a committed business checkpoint when a later business exceeds the source budget',async()=>{
 const f=fixture();const large=f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:'synthetic-large',rdjb:'2',titleCode:'specialized_sme',status:'success',queriedAt:'2026-10-18T01:00:00Z',rawResponse:'x'.repeat(4*1024*1024)}).returning().get()
 f.db.update(s.platformRelation).set({queryId:large.id}).where(eq(s.platformRelation.id,f.late.id)).run()
 const task=submitAnnualCorrespondence(f.db,f.read,{clientRequestId:'budget-partial',eventIds:[f.event.id]},f.dir);await whenIdle()
 expect(getJob(f.db,task.jobId)?.state).toBe('failed');expect((getJob(f.db,task.jobId)!.result as any).events[0]).toMatchObject({status:'failed',errorCode:'source_materialization_limit',outcomes:[{stepId:'early',status:'created'}]})
 const audit=f.audits();retryAnnualCorrespondence(f.db,f.read,task.jobId,f.dir);await whenIdle();expect(f.audits()).toEqual(audit);expect(f.rows().map(r=>r.relationId)).toEqual([f.early.id])
})
it('detects a new source between business checkpoints and blocks old-task final readback',async()=>{
 const f=fixture();const task=submitAnnualCorrespondence(f.db,f.read,{clientRequestId:'changing-mid-run',eventIds:[f.event.id]},f.dir)
 await new Promise<void>(resolve=>setImmediate(resolve));expect(f.rows()).toHaveLength(1);f.add('appended-business')
 await whenIdle();expect(getJob(f.db,task.jobId)?.state).toBe('failed');expect(f.rows()).toHaveLength(1)
 expect(readAnnualTask(f.db,f.read,task.jobId,true)).toMatchObject({capabilities:{retry:false},result:{events:[{errorCode:'source_generation_changed',finalQualification:{status:'blocked',reasons:['source_generation_changed']}}]}})
})
it('leaves durable queued tasks queued during public GET without running startup reconciliation',async()=>{
 const f=fixture();const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'read-only',eventIds:[f.event.id]});const before=getJob(f.db,task.jobId)
 const response=await handleAnnualTaskRequest('detail',{method:'GET',id:task.jobId},{db:f.db,readScope:f.read,filesDir:f.dir})
 expect(response.status).toBe(200);expect(response.body).toMatchObject({status:'queued'});expect(getJob(f.db,task.jobId)).toEqual(before)
 expect(f.db.select().from(s.importBatch).all()).toEqual([]);expect(f.audits()).toEqual([])
})
it.each([{name:'rejected',status:'rejected' as const},{name:'unlinked',status:'unlinked' as const}])('does not let another event $name block this event',({status})=>{
 const f=fixture();const other=f.db.insert(s.recordEvent).values({recordId:f.event.recordId,eventType:'award',year:2022,batchSeq:2}).returning().get()
 const id=f.manual('other-event-decision',[{action:'create',status:status==='rejected'?'rejected':'confirmed',edge:{type:'event_process',eventId:other.id,relationId:f.late.id,role:'context_only'}}]).correspondenceIds[0]!
 if(status==='unlinked')f.manual('other-event-cancel',[{action:'decide',correspondenceId:id,expectedRevision:2,status:'unlinked'}])
 expect(f.reconcile()).toMatchObject({status:'created',decisionRefs:[{relationId:f.late.id,status:'confirmed'}]})
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({stepId:'late',status:'confirmed'})
})
it('uses MCP credentials independently and never treats the REST credential as a MCP grant',async()=>{
 const {annualTaskMcpRequest}=await import('../server/utils/annual-correspondence-mcp');const f=fixture(),context={db:f.db,readScope:f.read,filesDir:f.dir,mcpToken:'mcp-only-secret'}
 expect(await annualTaskMcpRequest('submit',{clientRequestId:'mcp-no-config',eventIds:[f.event.id]},{requestInfo:{headers:{authorization:'Bearer mcp-only-secret'}}},{...context,mcpToken:''})).toMatchObject({isError:true})
 expect(await annualTaskMcpRequest('submit',{clientRequestId:'rest-is-not-mcp',eventIds:[f.event.id]},{requestInfo:{headers:{authorization:'Bearer rest-only-secret'}}},context)).toMatchObject({isError:true})
 expect(f.db.select().from(s.job).all()).toEqual([])
 const accepted=await annualTaskMcpRequest('submit',{clientRequestId:'mcp-real-grant',eventIds:[f.event.id]},{requestInfo:{headers:{'x-mcp-token':'mcp-only-secret'}}},context) as any
 await whenIdle();expect(getJob(f.db,accepted.jobId)?.state).toBe('done');expect(JSON.stringify(f.db.select().from(s.job).all())).not.toContain('mcp-only-secret')
})
it('keeps exact selected-version decision identity when the preferred latest observation is undecided',()=>{
 const f=fixture();f.reconcile();const duplicate=f.add('late')
 const read:AnnualScopeReader=(db,id)=>{const scope=f.read(db,id);if(!scope)return null;scope.steps.find(s=>s.stepId==='late')!.preferredRelationId=duplicate.id;return scope}
 const before=f.audits();const result=reconcileAnnualStep(f.db,read,{eventId:f.event.id,generation:f.scope().generation,stepId:'late'})
 expect(result).toMatchObject({status:'existing',relationId:f.late.id,decisionRefs:[{relationId:f.late.id,status:'confirmed'}]})
 expect(qualifyAnnualFinal(f.db,read(f.db,f.event.id)!)).toMatchObject({status:'confirmed',decisionRefs:[{relationId:f.late.id}]})
 expect(f.rows().some(r=>r.relationId===duplicate.id)).toBe(false);expect(f.audits()).toEqual(before)
})
it('rejects unauthorized MCP writes before resolving the database getter',async()=>{
 const {annualTaskMcpRequest}=await import('../server/utils/annual-correspondence-mcp')
 const context={get db():ReturnType<typeof useDb>{throw new Error('database must not open')},readScope:()=>null,filesDir:'',mcpToken:'configured-secret'}
 expect(await annualTaskMcpRequest('submit',{clientRequestId:'unauthorized',eventIds:[1]},{},context)).toMatchObject({isError:true,content:[{text:JSON.stringify({error:{code:'unauthorized'}})}]})
})
it('serves qualification on a read-only database and forbids admission before any preflight',async()=>{
 const f=fixture(),readonly=drizzle(new Database(join(f.dir,'synthetic.db'),{readonly:true}),{schema:s})
 try {
  const result=await handleAnnualTaskRequest('submit',{method:'POST',body:{clientRequestId:'readonly-denied',eventIds:[f.event.id]},headers:{authorization:'Bearer configured'}},{db:readonly,readScope:f.read,filesDir:f.dir,apiToken:'configured'})
  expect(result).toMatchObject({status:403,body:{error:{code:'readonly_database'}}})
  expect(qualifyAnnualFinal(readonly,f.read(readonly,f.event.id)!)).toMatchObject({status:'eligible',decisionRefs:[]})
  expect(f.db.select().from(s.job).all()).toEqual([]);expect(f.db.select().from(s.importBatch).all()).toEqual([]);expect(f.audits()).toEqual([])
 } finally {readonly.$client.close()}
})
it('initializes a read-only annual runner without reconciling queued rows or writing ledgers',()=>{
 const f=fixture();const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'readonly-startup',eventIds:[f.event.id]})
 const readonly=drizzle(new Database(join(f.dir,'synthetic.db'),{readonly:true}),{schema:s})
 const before=getJob(f.db,task.jobId)
 try {
  clearJobSpecs()
  expect(initializeAnnualCorrespondenceRunner(readonly,f.read)).toBe(0)
  expect(readAnnualTask(readonly,f.read,task.jobId,true)).toMatchObject({status:'queued',capabilities:{cancel:false,retry:false}})
  expect(getJob(f.db,task.jobId)).toEqual(before);expect(f.audits()).toEqual([]);expect(f.db.select().from(s.importBatch).all()).toEqual([])
 } finally {readonly.$client.close()}
})
it('honors concurrent manual reselection after task admission without restoring the cancelled choice',async()=>{
 const f=fixture();const original=f.reconcile();const id=original.decisionRefs[0]!.id
 const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'reselect-race',eventIds:[f.event.id]})
 const concurrent=drizzle(new Database(join(f.dir,'synthetic.db')),{schema:s})
 const request:CorrespondenceRequest={idempotencyKey:'concurrent-reselection',sourceIdentity:'synthetic/manual-reselection',actor:{type:'user',id:'other-reviewer'},basis:'explicitly replace selected process',ruleId:'manual',ruleVersion:'1',operations:[{action:'correct',correspondenceId:id,expectedRevision:2,edge:{type:'event_process',eventId:f.event.id,relationId:f.early.id,role:'context_only'}}]}
 const plan=preflightRecordCorrespondences(concurrent,request);commitRecordCorrespondences(concurrent,request,plan.planHash);concurrent.$client.close();const audit=f.audits()
 activateAnnualCorrespondence(f.db,f.read,[task.jobId],f.dir);await whenIdle()
 expect(f.rows().map(r=>[r.relationId,r.status])).toEqual([[f.late.id,'unlinked'],[f.early.id,'confirmed']]);expect(f.audits()).toEqual(audit)
 expect(readAnnualTask(f.db,f.read,task.jobId,false)?.result?.events[0]?.finalQualification).toMatchObject({stepId:null,status:'blocked',reasons:['protected_decision']})
})
it('does not borrow task-center same-origin permission to cancel annual business work',async()=>{
 const {handleTaskCenterRequest}=await import('../server/utils/task-center-http');const f=fixture()
 const task=stageAnnualCorrespondence(f.db,f.read,{clientRequestId:'weak-task-center-gate',eventIds:[f.event.id]})
 const context={db:f.db,filesDir:f.dir,apiToken:'api-only',browserAuthorized:true}
 const path=`/api/task-center/${task.jobId}`
 const detail=await handleTaskCenterRequest('detail',{method:'GET',path},context)
 const denied=await handleTaskCenterRequest('cancel',{method:'POST',path:path+'/cancel'},context)
 expect(denied.status).toBe(401)
 expect(detail.body).toMatchObject({capabilities:{cancel:false,retry:false}})
 expect((await handleTaskCenterRequest('retry',{method:'POST',path:path+'/retry'},context)).status).toBe(401)
 expect(getJob(f.db,task.jobId)?.state).toBe('queued');expect(f.audits()).toEqual([])
 expect((await handleTaskCenterRequest('cancel',{method:'POST',path:path+'/cancel',headers:{authorization:'Bearer api-only'}},context)).status).toBe(200)
 expect(getJob(f.db,task.jobId)?.state).toBe('cancelled')
 expect((await handleTaskCenterRequest('retry',{method:'POST',path:path+'/retry',headers:{authorization:'Bearer api-only'}},context)).status).toBe(409)
 expect(getJob(f.db,task.jobId)?.state).toBe('cancelled')
})
it('retains task-center weak browser cancellation capability for nonannual kinds',async()=>{
 const {handleTaskCenterRequest}=await import('../server/utils/task-center-http');const {createJob}=await import('../server/utils/job-store');const {newJobId}=await import('../lib/job');const f=fixture()
 const row=createJob(f.db,{id:newJobId(),kind:'ocr',params:{},progress:{done:0,total:1}}),path=`/api/task-center/${row.id}`
 const context={db:f.db,filesDir:f.dir,browserAuthorized:true}
 expect((await handleTaskCenterRequest('detail',{method:'GET',path},context)).body).toMatchObject({capabilities:{cancel:true}})
 expect((await handleTaskCenterRequest('cancel',{method:'POST',path:path+'/cancel'},context)).status).toBe(200)
 expect(getJob(f.db,row.id)?.state).toBe('cancelled')
})
