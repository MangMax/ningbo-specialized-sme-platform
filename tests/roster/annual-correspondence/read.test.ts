import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {eq} from 'drizzle-orm'
import {afterEach,expect,it,vi} from 'vitest'
import {initializeDb,schema as s} from '../../../db/client'
import {readEventAnnualProcess} from '../../../server/utils/event-annual-process-read'
import {enrichAnnualProcessFinalQualification,readAnnualWriteScope} from '../../../server/utils/annual-correspondence-read'
import {qualifyAnnualFinal,readAnnualDecisionRefs,reconcileAnnualStep} from '../../../server/utils/annual-correspondence'
import {submitNativePlatformQuery} from '../../platform/fixtures/native-query'
import {commitRecordCorrespondences,preflightRecordCorrespondences,type CorrespondenceRequest,listRecordCorrespondences} from '../../../server/utils/record-correspondence'
import {clearJobSpecs,__resetJobRunner,whenIdle} from '../../../layers/core/server/utils/job-runner'
import {handleAnnualTaskRequest} from '../../../server/utils/annual-correspondence-api'
import {getJob} from '../../../layers/core/server/utils/job-store'
let active:ReturnType<typeof initializeDb>
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(definition:unknown)=>definition}))
vi.mock('@db',()=>({useDb:()=>active}))
const dirs:string[]=[]
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'annual-read-251-'));dirs.push(dir);const db=initializeDb({ create: true, dbPath:join(dir,'synthetic.db')});active=db;clearJobSpecs();__resetJobRunner()
 vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'rest-251',mcpToken:'mcp-251',filesDir:dir,}))
 const enterprise=db.insert(s.enterprise).values({name:'合成年份互证企业',nameNorm:'合成年份互证企业',usccNorm:'91330211255994457P'}).returning().get()
 const record=db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',usccRaw:enterprise.usccNorm}).returning().get()
 const event=db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2024}).returning().get();let serial=0
 const add=(options:{key?:string;year?:number|null;status?:string;source?:'business_list'|'apply_list';title?:string|null;rdjb?:string;appliedAt?:string;rawStatus?:boolean;kind?:'apply'|'review';padding?:string;queryRaw?:string}={})=>{
  const key=options.key??'SAME-1',year=options.year===undefined?2024:options.year,status=options.status??'终审通过',source=options.source??'business_list',appliedAt=options.appliedAt??'2024-06-01'
  const n=++serial
  const rawFields={...(options.padding?{padding:options.padding}:{}),id:key,sblx:options.kind==='review'?'复核':'申请',sqsj:appliedAt,...(year==null?{}:{year:String(year)}),...(options.rawStatus===false?{}:{cszt:status})}
  const seeded=submitNativePlatformQuery(db,{interface:source,queryKey:enterprise.usccNorm!,queriedAt:`2026-10-20T00:${String(n).padStart(2,'0')}:00Z`,rdjb:options.rdjb??(source==='business_list'?'2':''),titleCode:options.title??null,status:'success',rawResponse:options.queryRaw??'immutable synthetic archive',relations:[{sequenceNo:1,relationKey:key,enterpriseId:enterprise.id,usccRaw:enterprise.usccNorm,nameRaw:enterprise.name,declareKind:options.kind??'apply',year,appliedAt,status,verificationStatus:'confirmed',rawFields}]})
  const query={id:seeded.queryId},relation={id:seeded.relationIds[0]!}

  return {query,relation}
 }
 const scope=()=>readAnnualWriteScope(db,event.id)!
 const reconcile=(stepId=scope().steps[0]!.stepId)=>reconcileAnnualStep(db,readAnnualWriteScope,{eventId:event.id,generation:scope().generation,stepId})
 const manual=(key:string,operations:CorrespondenceRequest['operations'])=>{const request:CorrespondenceRequest={idempotencyKey:key,sourceIdentity:'synthetic/'+key,actor:{type:'user',id:'reviewer'},basis:'explicit actual observation',ruleId:'manual',ruleVersion:'1',operations};const plan=preflightRecordCorrespondences(db,request);return commitRecordCorrespondences(db,request,plan.planHash)}
 return{db,dir,event,enterprise,record,add,scope,reconcile,manual}
}
afterEach(async()=>{await whenIdle();__resetJobRunner();clearJobSpecs();vi.unstubAllGlobals();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
it('writes native-title business endpoints using annual year lineage and retains early failure with unique late final',()=>{
 const f=fixture();const early=f.add({key:'EARLY',year:null,status:'终审不通过',appliedAt:'2024-01-01'});f.add({key:'EARLY',source:'apply_list',year:2024,status:'终审不通过',appliedAt:'2024-01-01'})
 const late=f.add({key:'LATE',year:null});f.add({key:'LATE',source:'apply_list',year:2024})
 const sourceBefore={collections:f.db.select().from(s.platformCollection).all(),observations:f.db.select().from(s.platformBusinessObservation).all(),versions:f.db.select().from(s.platformBusinessRecordVersion).all()}
 const before=readEventAnnualProcess(f.db,f.event.id)!;expect(before.process.steps).toHaveLength(2);expect(before.process.finalCandidateStepId).not.toBeNull()
 expect(f.scope().steps.map(step=>step.preferredRelationId)).toEqual([early.relation.id,late.relation.id])
 for(const step of f.scope().steps)expect(f.reconcile(step.stepId).status).toBe('created')
 const enriched=enrichAnnualProcessFinalQualification(f.db,readEventAnnualProcess(f.db,f.event.id)!)
 expect(enriched.sourceGeneration).toBe(before.sourceGeneration);expect(enriched.process.finalQualification).toMatchObject({stepId:before.process.finalCandidateStepId,status:'confirmed',decisionRefs:[{relationId:late.relation.id,requiresRevalidation:false}]})
 expect(listRecordCorrespondences(f.db).map(row=>row.relationId)).toEqual([early.relation.id,late.relation.id])
 expect({collections:f.db.select().from(s.platformCollection).all(),observations:f.db.select().from(s.platformBusinessObservation).all(),versions:f.db.select().from(s.platformBusinessRecordVersion).all()}).toEqual(sourceBefore)
})
it.each([{name:'rejected',status:'rejected' as const},{name:'unlinked',status:'unlinked' as const}])('protects same-event manual $name on a verified version outside the current annual scope',({status})=>{
 const f=fixture();const old=f.add({year:2023,kind:'review'}),current=f.add({year:2024})
 const id=f.manual('historical-manual',[{action:'create',status:status==='rejected'?'rejected':'confirmed',edge:{type:'event_process',eventId:f.event.id,relationId:old.relation.id,role:'context_only'}}]).correspondenceIds[0]!
 if(status==='unlinked')f.manual('historical-cancel',[{action:'decide',correspondenceId:id,expectedRevision:2,status:'unlinked'}])
 const pure=readEventAnnualProcess(f.db,f.event.id)!;expect(pure.sourceRefs.observations.map(ref=>ref.relationId)).not.toContain(old.relation.id)
 const scope=f.scope();expect(scope.generation).toBe(pure.sourceGeneration);expect(scope.steps[0]!.currentRelationIds).toEqual([current.relation.id]);expect(scope.steps[0]!.protectionRelationIds).toContain(old.relation.id)
 const audits=f.db.select().from(s.recordCorrespondenceAudit).all();expect(f.reconcile()).toMatchObject({status:'protected',decisionRefs:[{id,relationId:old.relation.id,status}]})
 expect(enrichAnnualProcessFinalQualification(f.db,pure).process.finalQualification).toMatchObject({stepId:null,status:'blocked',reasons:['protected_decision']})
 expect(f.db.select().from(s.recordCorrespondenceAudit).all()).toEqual(audits)
})
it('does not let a different event historical rejection block current-year confirmation',()=>{
 const f=fixture(),old=f.add({year:2023,kind:'review'}),current=f.add({year:2024});const other=f.db.insert(s.recordEvent).values({recordId:f.record.id,eventType:'award',year:2023}).returning().get()
 f.manual('other-event-history',[{action:'create',status:'rejected',edge:{type:'event_process',eventId:other.id,relationId:old.relation.id,role:'context_only'}}])
 expect(f.reconcile()).toMatchObject({status:'created',decisionRefs:[{relationId:current.relation.id}]});expect(qualifyAnnualFinal(f.db,f.scope()).status).toBe('confirmed')
})
it('requires an independent new-version decision and preserves the old fingerprint and audit',()=>{
 const f=fixture();const old=f.add({status:'终审不通过'});f.manual('old-confirmed',[{action:'create',status:'confirmed',edge:{type:'event_process',eventId:f.event.id,relationId:old.relation.id,role:'context_only'}}])
 const oldRow=f.db.select().from(s.recordCorrespondence).get()!,audit=f.db.select().from(s.recordCorrespondenceAudit).all();const current=f.add()
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({status:'eligible',decisionRefs:[]});expect(f.scope().steps[0]!.currentRelationIds).toEqual([current.relation.id])
 expect(f.reconcile()).toMatchObject({status:'created',decisionRefs:[{relationId:current.relation.id}]});expect(f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id,oldRow.id)).get()).toEqual(oldRow)
 expect(f.db.select().from(s.recordCorrespondenceAudit).all().slice(0,audit.length)).toEqual(audit)
})
it('ignores an old differing stored status when the typed projection has no status',()=>{
 const f=fixture(),old=f.add({status:'终审不通过',rawStatus:false});f.manual('old-raw-equal',[{action:'create',status:'confirmed',edge:{type:'event_process',eventId:f.event.id,relationId:old.relation.id,role:'context_only'}}]);const current=f.add({rawStatus:false})
 const versions=f.db.select().from(s.platformBusinessObservation).all();expect(versions[0]!.versionId).toBe(versions[1]!.versionId)
 expect(f.scope().steps[0]!.currentRelationIds).toEqual([old.relation.id,current.relation.id])
 expect(f.scope().steps[0]!.reasons).toContain('latest_status_missing')
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({stepId:null,status:'none'})
 expect(f.reconcile()).toMatchObject({status:'existing',relationId:old.relation.id})
})
it('never falls back to an older confirmed pass after a later application fails',()=>{
 const f=fixture();const old=f.add({key:'OLD',appliedAt:'2024-01-01'});f.reconcile();const latest=f.add({key:'LATEST',status:'终审不通过',appliedAt:'2024-12-01'})
 expect(f.scope().finalCandidateStepId).toBeNull();expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({stepId:null,status:'none'})
 expect(listRecordCorrespondences(f.db)[0]!.relationId).toBe(old.relation.id);expect(f.scope().steps.some(step=>step.currentRelationIds.includes(latest.relation.id))).toBe(true)
})
it('blocks enrichment of stale generation instead of attaching a new-scope final and never writes on GET',()=>{
 const f=fixture();f.add();f.reconcile();const old=readEventAnnualProcess(f.db,f.event.id)!;f.add({key:'APPENDED',status:'终审不通过',appliedAt:'2024-12-01'})
 const before={jobs:f.db.select().from(s.job).all(),ledger:f.db.select().from(s.importBatch).all(),audit:f.db.select().from(s.recordCorrespondenceAudit).all()}
 expect(enrichAnnualProcessFinalQualification(f.db,old).process.finalQualification).toMatchObject({stepId:null,status:'blocked',reasons:['source_generation_changed']})
 expect({jobs:f.db.select().from(s.job).all(),ledger:f.db.select().from(s.importBatch).all(),audit:f.db.select().from(s.recordCorrespondenceAudit).all()}).toEqual(before)
})
it('runs the registered MCP handlers with independent credentials and the actual annual read and queue',async()=>{
 const f=fixture();f.add();const submit=(await import('../../../server/mcp/tools/submit_event_annual_correspondence_task')).default
 const get=(await import('../../../server/mcp/tools/get_event_annual_correspondence_task')).default
 expect(await submit.handler({clientRequestId:'handler-deny',eventIds:[f.event.id]},{} as never)).toMatchObject({isError:true});expect(f.db.select().from(s.job).all()).toEqual([])
 const result=await submit.handler({clientRequestId:'handler-allow',eventIds:[f.event.id]},{requestInfo:{headers:{authorization:'Bearer mcp-251'}}} as never) as any
 await whenIdle();expect(getJob(f.db,result.jobId)?.state).toBe('done');expect(await get.handler({id:result.jobId},{} as never)).toMatchObject({status:'done',result:{events:[{finalQualification:{status:'confirmed'}}]}})
 const rest=await handleAnnualTaskRequest('submit',{method:'POST',headers:{authorization:'Bearer rest-251'},body:{clientRequestId:'rest-same-scope',eventIds:[f.event.id]}},{db:f.db,readScope:readAnnualWriteScope,filesDir:f.dir,apiToken:'rest-251'})
 expect(rest.body).toMatchObject({jobId:result.jobId})
})
it('reads same-state same-version confirmation from its actual old observation without duplicating the latest observation',()=>{
 const f=fixture(),old=f.add();f.manual('same-version-confirmation',[{action:'create',status:'confirmed',edge:{type:'event_process',eventId:f.event.id,relationId:old.relation.id,role:'context_only'}}]);const current=f.add()
 const audits=f.db.select().from(s.recordCorrespondenceAudit).all();expect(f.scope().steps[0]!.preferredRelationId).toBe(current.relation.id)
 expect(f.reconcile()).toMatchObject({status:'existing',relationId:old.relation.id,decisionRefs:[{relationId:old.relation.id}]})
 expect(enrichAnnualProcessFinalQualification(f.db,readEventAnnualProcess(f.db,f.event.id)!).process.finalQualification).toMatchObject({status:'confirmed',decisionRefs:[{relationId:old.relation.id}]})
 expect(f.db.select().from(s.recordCorrespondence).all()).toHaveLength(1);expect(f.db.select().from(s.recordCorrespondenceAudit).all()).toEqual(audits)
})
it('preserves a historical business-year contradiction as no final rather than discarding its adverse version',()=>{
 const f=fixture();f.add({year:2023});f.add({year:2024});expect(f.scope().finalCandidateStepId).toBeNull();expect(f.reconcile()).toMatchObject({status:'needs_review'})
 expect(qualifyAnnualFinal(f.db,f.scope())).toMatchObject({stepId:null,status:'none'});expect(f.db.select().from(s.recordCorrespondence).all()).toEqual([])
})
it('does not use derived annual title as native title proof for an archived apply candidate',()=>{
 const f=fixture(),business=f.add({year:null}),apply=f.add({source:'apply_list',year:2024})
 const candidateId=f.manual('unknown-native-title-candidate',[{action:'create',status:'candidate',edge:{type:'event_process',eventId:f.event.id,relationId:apply.relation.id,role:'context_only'}}]).correspondenceIds[0]!
 const before=f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id,candidateId)).get()
 expect(readAnnualDecisionRefs(f.db,[apply.relation.id])).toMatchObject([{id:candidateId,requiresRevalidation:true}])
 expect(f.reconcile()).toMatchObject({status:'created',relationId:business.relation.id,decisionRefs:[{relationId:business.relation.id}]})
 expect(f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id,candidateId)).get()).toEqual(before)
})
it('qualifies a real confirmed edge without hydrating its multi-megabyte raw or audit provenance on GET',()=>{
 const f=fixture(),marker='ANNUAL_RAW_SENTINEL_',row=f.add({padding:marker+'x'.repeat(512*1024),queryRaw:marker+'y'.repeat(3*1024*1024)})
 expect(f.reconcile().status).toBe('created')
 let rawBytes=0,stringBytes=0;const prepare=f.db.$client.prepare.bind(f.db.$client)
 const count=(value:unknown):void=>{if(typeof value==='string'){stringBytes+=Buffer.byteLength(value);if(value.includes(marker))rawBytes+=Buffer.byteLength(value)}else if(value&&typeof value==='object')Object.values(value).forEach(count)}
 f.db.$client.prepare=((query:string)=>{const statement=prepare(query);for(const method of ['get','all'] as const){const original=statement[method].bind(statement);Object.assign(statement,{[method]:(...args:unknown[])=>{const result=original(...args);count(result);return result}})}return statement}) as typeof prepare
 try {
  const result=enrichAnnualProcessFinalQualification(f.db,readEventAnnualProcess(f.db,f.event.id)!)
  expect(result.process.finalQualification).toMatchObject({status:'confirmed',decisionRefs:[{relationId:row.relation.id,requiresRevalidation:false}]})
  expect(rawBytes).toBe(0);expect(stringBytes).toBeLessThan(128*1024)
 } finally {f.db.$client.prepare=prepare}
})
