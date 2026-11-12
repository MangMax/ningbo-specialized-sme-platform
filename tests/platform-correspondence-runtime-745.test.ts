import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { preflightComparisonScopeProofs, commitComparisonScopeProofs, resolveVerifiedComparisonEvidence, type ProofRequest } from '../server/utils/comparison-scope-proof'
import * as schema from '../db/schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import Database from 'better-sqlite3'
import {drizzle} from 'drizzle-orm/better-sqlite3'
import {copyFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest'
import {processReaderFixture} from './helpers/process-target-734'
import {transferCorrespondence} from '../upgrade/correspondence'
import {createOfflineSnapshot} from '../upgrade/offline-snapshot'
import {targetSchema} from '../lib/platform/target-schema'
import {readSource,details} from '../server/utils/record-correspondence-read'
import {preflightRecordCorrespondences,commitRecordCorrespondences,listRecordCorrespondences,readRecordCorrespondenceBatch, listRecordCorrespondenceRefs, pageRecordCorrespondences, getRecordCorrespondenceAudit, createEnterpriseTitleCorrespondenceRefsReader, type CorrespondenceRequest} from '../server/utils/record-correspondence'
let f:Awaited<ReturnType<typeof processReaderFixture>>,t:Database.Database,db:ReturnType<typeof drizzle<typeof schema>>
const statements:string[]=[]
let proofId: number
let currentProofRequest:ProofRequest
beforeAll(async()=>{
 f=await processReaderFixture(false, source => {
  source.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,title_code,queried_at,status,created_at) VALUES(114,'business_list','normal','2','specialized_sme','2026-01-01','success','c')")
  const old = drizzle(source,{schema})
  for(const id of [103,104,105,106,107,108,109]) {
   old.insert(schema.platformRelation).values({id,queryId:114,sequenceNo:id-102,relationKey:'normal-'+id,enterpriseId:1,usccRaw:'U1',nameRaw:'Alpha',verificationStatus:'confirmed',rawFields:{id:'normal-'+id,rdjb:'2',sblx:'复核',sqsj:'2026-01-01',year:2026}}).run()
   ensurePlatformObservation(old,id)
  }
  old.insert(schema.record).values({id:100,enterpriseId:1,titleCode:'specialized_sme',source:'jxj',usccRaw:'U1'}).run()
  old.insert(schema.recordEvent).values([{id:100,recordId:100,eventType:'award',year:2022},{id:101,recordId:100,eventType:'award',year:2022}]).run()
  const req:CorrespondenceRequest={idempotencyKey:'before-migration',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',operations:[{action:'create',status:'confirmed',edge:{type:'later_process',enterpriseId:1,titleCode:'specialized_sme',relationId:103,role:'followup_review'}}]}
  const plan=preflightRecordCorrespondences(old,req);commitRecordCorrespondences(old,req,plan.planHash)
  const apply = old.insert(schema.platformQuery).values({id:115,interface:'apply_list',queryKey:'apply',rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-01-01',status:'success'}).returning().get()
  old.insert(schema.platformRelation).values({id:301,queryId:apply.id,sequenceNo:1,relationKey:'apply301',enterpriseId:1,usccRaw:'U1',nameRaw:'Alpha',verificationStatus:'confirmed',rawFields:{id:'apply301',rdjb:'2',sblx:'申请',sqsj:'2026-01-01'}}).run()
  ensurePlatformObservation(old,301)
  const conditions={combination:'and' as const}
  const collection={source:'queryBusList',status:'success',effectiveConditions:conditions,titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:01:00Z',rows:[],pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}} satisfies NonNullable<typeof schema.platformQuery.$inferInsert.collectionEvidence>
  old.insert(schema.platformQuery).values({id:121,interface:'recognized_list',queryKey:'all',rdjb:'2',titleCode:'specialized_sme',queriedAt:collection.queriedAt,status:'success',collectionEvidence:collection}).run()
  old.insert(schema.platformRelation).values({id:201,queryId:121,sequenceNo:1,relationKey:'recognized201',enterpriseId:1,usccRaw:'U1',nameRaw:'Alpha',verificationStatus:'confirmed',rawFields:{id:'recognized201',rdjb:'2',whpcyear:'2026',whpc:'2026-1'}}).run()
  ensurePlatformObservation(old,201)
  old.insert(schema.platformExportBatch).values({id:50,titleCode:'specialized_sme',year:2026,collectedOn:'2026-01-01',originalFilename:'synthetic.xlsx',sha256:'b'.repeat(64),importStatus:'imported'}).run()
  old.insert(schema.platformExportRow).values([{id:51,batchId:50,sourceRowNo:1,usccRaw:'U1',nameRaw:'Alpha'},{id:52,batchId:50,sourceRowNo:2,usccRaw:'U1',nameRaw:'Alpha'}]).run()
  const freeze=old.insert(schema.storedFile).values({relPath:'synthetic/freeze745',filename:'freeze.txt',ext:'txt',bytes:24,sha256:'c'.repeat(64),source:'miit',kind:'export'}).returning().get()
  const proof:ProofRequest={...req,idempotencyKey:'proof-before',operations:[{action:'create',kind:'current_source_equivalence',status:'confirmed',evidence:{queryId:121,exportBatchId:50,titleCode:'specialized_sme',queryReference:'platform_query.collectionEvidence',exportReference:'platform_export_batch.sha256',scope:{queryAccount:'normal',exportAccount:'normal',queryRegion:'normal',exportRegion:'normal',queryFilters:conditions,exportFilters:conditions,windowStart:'2026-01-01T00:00:00Z',windowEnd:'2026-01-01T23:59:59Z',platformVersion:'v1',freezeReference:freeze.relPath,freezeFileId:freeze.id,freezeSha256:freeze.sha256!}}}]}
  currentProofRequest=proof
  proofId=commitComparisonScopeProofs(old,proof,preflightComparisonScopeProofs(old,proof).planHash).proofIds[0]!
  const recognized:CorrespondenceRequest={...req,idempotencyKey:'recognized-before',proofIds:[proofId],operations:[{action:'create',status:'confirmed',edge:{type:'recognized_export',relationId:201,exportRowId:51,role:'same_current_row'}}]}
  commitRecordCorrespondences(old,recognized,preflightRecordCorrespondences(old,recognized).planHash)
  const applyReq:CorrespondenceRequest={...req,idempotencyKey:'apply-before',operations:[{action:'create',status:'confirmed',edge:{type:'later_process',enterpriseId:1,titleCode:'specialized_sme',relationId:301,role:'followup_apply'}}]}
  commitRecordCorrespondences(old,applyReq,preflightRecordCorrespondences(old,applyReq).planHash)

 })
 const source=join(f.root,'runtime-source.sqlite'),target=join(f.root,'runtime-target.sqlite')
 await createOfflineSnapshot(f.target,source);copyFileSync(source,target)
 transferCorrespondence({source,target,runId:'runtime745'})
 t=new Database(target,{verbose:q=>statements.push(String(q))});t.pragma('foreign_keys=ON');db=drizzle(t,{schema})
})
beforeEach(()=>t.exec('SAVEPOINT correspondence_case'))
afterEach(()=>t.exec('ROLLBACK TO correspondence_case; RELEASE correspondence_case'))
afterAll(()=>{t?.close();f?.close()})
it('reads migrated sources lists and details through the public services',()=>{
 expect(readSource(db,'relation',3)).toEqual(readSource(f.old,'relation',3))
 for (const id of [1,2,4,5,6,7,103,201,301]) expect(readSource(db,'relation',id)).toEqual(readSource(f.old,'relation',id))
 expect(readSource(db,'event',100)).toEqual(readSource(f.old,'event',100))
 expect(readSource(db,'export_row',51)).toEqual(readSource(f.old,'export_row',51))
 const rows=listRecordCorrespondences(db)
 expect(rows).toEqual(listRecordCorrespondences(f.old))
 expect(listRecordCorrespondenceRefs(db, {relationId:103})).toEqual(listRecordCorrespondenceRefs(f.old,{relationId:103}))
 expect(pageRecordCorrespondences(db,{relationId:103},{page:1,pageSize:1})).toEqual(pageRecordCorrespondences(f.old,{relationId:103},{page:1,pageSize:1}))
 expect(details(db,rows)).toEqual(details(f.old,listRecordCorrespondences(f.old)))
})
it('creates replays and unlinks a normal process decision with a target observation FK',()=>{
 const request:CorrespondenceRequest={idempotencyKey:'runtime-create',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',operations:[{action:'create',status:'confirmed',edge:{type:'later_process',enterpriseId:1,titleCode:'specialized_sme',relationId:104,role:'followup_review'}}]}
 const plan=preflightRecordCorrespondences(db,request),receipt=commitRecordCorrespondences(db,request,plan.planHash)
 expect(plan.impact).toEqual({created:1,unlinked:0,audit:2})
 expect(commitRecordCorrespondences(db,request,plan.planHash)).toEqual(receipt)
 expect(preflightRecordCorrespondences(db,request)).toMatchObject({batchStatus:'committed',planHash:plan.planHash})
 expect(()=>commitRecordCorrespondences(db,{...request,basis:'changed'},plan.planHash)).toThrowError(expect.objectContaining({code:'idempotency_conflict'}))
 expect(t.prepare('SELECT observation_id FROM record_correspondence WHERE id=?').get(receipt.correspondenceIds[0])).toEqual(t.prepare('SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=104').get())
 expect(getRecordCorrespondenceAudit(db,receipt.correspondenceIds[0]!)).toHaveLength(2)
 const row=listRecordCorrespondences(db,{id:receipt.correspondenceIds[0]})[0]!
 expect(row).toMatchObject({relationId:104,status:'confirmed',requiresRevalidation:false})
 const unlink:CorrespondenceRequest={...request,idempotencyKey:'runtime-unlink',operations:[{action:'decide',correspondenceId:row.id,expectedRevision:row.revision,status:'unlinked'}]}
 const next=preflightRecordCorrespondences(db,unlink);commitRecordCorrespondences(db,unlink,next.planHash)
 expect(listRecordCorrespondences(db,{id:row.id})[0]).toMatchObject({status:'unlinked',revision:row.revision+1})
 expect(t.pragma('foreign_key_check')).toEqual([])
})
it('preserves revision conflicts and rolls back a failed multi-edge commit before retry',()=>{
 const request:CorrespondenceRequest={idempotencyKey:'runtime-rollback',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',operations:[105,106].map(relationId=>({action:'create',status:'confirmed',edge:{type:'later_process',enterpriseId:1,titleCode:'specialized_sme',relationId,role:'followup_review'}}))}
 const plan=preflightRecordCorrespondences(db,request)
 const auditCount=t.prepare('SELECT count(*) n FROM record_correspondence_audit').get()
 t.exec(`CREATE TRIGGER runtime_fail_second BEFORE INSERT ON record_correspondence WHEN NEW.observation_id=(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=106) BEGIN SELECT RAISE(ABORT,'synthetic second write failure'); END`)
 expect(()=>commitRecordCorrespondences(db,request,plan.planHash)).toThrow('synthetic second write failure')
 expect(listRecordCorrespondences(db,{relationId:105})).toEqual([])
 expect(listRecordCorrespondences(db,{relationId:106})).toEqual([])
 expect(t.prepare('SELECT count(*) n FROM record_correspondence_audit').get()).toEqual(auditCount)
 expect(readRecordCorrespondenceBatch(db,request.idempotencyKey)).toBeNull()
 t.exec('DROP TRIGGER runtime_fail_second')
 const receipt=commitRecordCorrespondences(db,request,plan.planHash)
 expect(receipt.correspondenceIds).toHaveLength(2)
 const row=listRecordCorrespondences(db,{id:receipt.correspondenceIds[0]})[0]!
 const unlink:CorrespondenceRequest={...request,idempotencyKey:'stale-unlink',operations:[{action:'decide',correspondenceId:row.id,expectedRevision:row.revision,status:'unlinked'}]}
 const stale=preflightRecordCorrespondences(db,unlink)
 const competing={...unlink,idempotencyKey:'winning-unlink'}
 commitRecordCorrespondences(db,competing,preflightRecordCorrespondences(db,competing).planHash)
 expect(()=>commitRecordCorrespondences(db,unlink,stale.planHash)).toThrowError(expect.objectContaining({code:'stale_revision'}))
 expect(listRecordCorrespondences(db,{id:row.id})[0]).toMatchObject({status:'unlinked',revision:row.revision+1})
 expect(t.pragma('foreign_key_check')).toEqual([])
})

it('keeps proof-backed recognized decisions current and observes normal proof revocation',()=>{
 expect(resolveVerifiedComparisonEvidence(db,[proofId])).toEqual(resolveVerifiedComparisonEvidence(f.old,[proofId]))
 const fresh={...currentProofRequest,idempotencyKey:'proof-after-migration'}
 const freshReceipt=commitComparisonScopeProofs(db,fresh,preflightComparisonScopeProofs(db,fresh).planHash)
 expect(resolveVerifiedComparisonEvidence(db,freshReceipt.proofIds).currentScopes).toMatchObject([{queryId:121,exportBatchId:50}])
 const readRefs=createEnterpriseTitleCorrespondenceRefsReader(db)
 expect(readRefs(1,'specialized_sme').find(row=>row.relationId===201)).toMatchObject({requiresRevalidation:false})
 const before=listRecordCorrespondences(db,{relationId:201})[0]!
 expect(before).toMatchObject({role:'same_current_row',status:'confirmed',requiresRevalidation:false})
 const revoke:ProofRequest={idempotencyKey:'revoke-proof',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal revoke',ruleId:'r',ruleVersion:'v',operations:[{action:'decide',proofId,expectedRevision:2,status:'revoked'}]}
 commitComparisonScopeProofs(db,revoke,preflightComparisonScopeProofs(db,revoke).planHash)
 expect(listRecordCorrespondences(db,{id:before.id})[0]).toMatchObject({requiresRevalidation:true,status:'confirmed'})
 expect(listRecordCorrespondenceRefs(db,{relationId:201})[0]).toMatchObject({relationId:201,requiresRevalidation:true})
 expect(readRefs(1,'specialized_sme').find(row=>row.relationId===201)).toMatchObject({requiresRevalidation:true})
 expect(t.pragma('foreign_key_check')).toEqual([])
})

it('serves source list detail audit and authenticated writes through the unchanged public handler',()=>{
 const context={db,apiToken:['synthetic','745','test'].join('-')}
 for(const input of [
  {action:'source' as const,method:'GET',kind:'relation' as const,id:'103'},
  {action:'source' as const,method:'GET',kind:'event' as const,id:'100'},
  {action:'list' as const,method:'GET',query:{relationId:'103',pageSize:'1'}},
 ]) expect(handleRecordCorrespondenceRequest(input,context)).toEqual(handleRecordCorrespondenceRequest(input,{db:f.old,apiToken:context.apiToken}))
 const request:CorrespondenceRequest={idempotencyKey:'handler-create',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',operations:[{action:'create',status:'candidate',edge:{type:'event_process',eventId:100,relationId:107,role:'context_only'}}]}
 expect(handleRecordCorrespondenceRequest({action:'preflight',method:'POST',body:request},context)).toMatchObject({status:401})
 expect(handleRecordCorrespondenceRequest({action:'preflight',method:'POST',body:request,headers:{authorization:'Bearer '+context.apiToken}},context)).toMatchObject({status:200,body:{impact:{created:1}}})
 const plan=z.object({planHash:z.string()}).parse(handleRecordCorrespondenceRequest({action:'preflight',method:'POST',body:request,headers:{authorization:'Bearer '+context.apiToken}},context).body)
 expect(handleRecordCorrespondenceRequest({action:'commit',method:'POST',body:{request,planHash:plan.planHash},headers:{authorization:'Bearer '+context.apiToken}},context)).toMatchObject({status:200,body:{planHash:plan.planHash}})
 const receipt=readRecordCorrespondenceBatch(db,request.idempotencyKey)!
 const id=receipt.correspondenceIds[0]!
 expect(handleRecordCorrespondenceRequest({action:'get',method:'GET',id:String(id)},context)).toMatchObject({status:200,body:{relationId:107,eventId:100,requiresRevalidation:false}})
 expect(handleRecordCorrespondenceRequest({action:'audit',method:'GET',id:String(id)},context)).toMatchObject({status:200,body:{total:1}})
 const confirm:CorrespondenceRequest={...request,idempotencyKey:'handler-confirm',operations:[{action:'decide',correspondenceId:id,expectedRevision:1,status:'confirmed'}]}
 commitRecordCorrespondences(db,confirm,preflightRecordCorrespondences(db,confirm).planHash)
 const replacement:CorrespondenceRequest={...request,idempotencyKey:'handler-replace',operations:[{action:'correct',correspondenceId:id,expectedRevision:2,edge:{type:'event_process',eventId:100,relationId:108,role:'context_only'}}]}
 const changed=commitRecordCorrespondences(db,replacement,preflightRecordCorrespondences(db,replacement).planHash)
 expect(listRecordCorrespondences(db,{id})).toMatchObject([{relationId:107,status:'unlinked',revision:3}])
 expect(listRecordCorrespondences(db,{id:changed.correspondenceIds[1]})).toMatchObject([{relationId:108,status:'confirmed',requiresRevalidation:false}])
 expect(readSource(db,'relation',107)).toMatchObject({correspondences:[{relationId:107,status:'unlinked'}]})
 expect(t.pragma('foreign_key_check')).toEqual([])
})

it('revalidates a candidate after a normal official revision and preserves the original audit',()=>{
 const request:CorrespondenceRequest={idempotencyKey:'candidate-source',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',operations:[{action:'create',status:'candidate',edge:{type:'event_process',eventId:101,relationId:109,role:'context_only'}}]}
 const receipt=commitRecordCorrespondences(db,request,preflightRecordCorrespondences(db,request).planHash)
 const id=receipt.correspondenceIds[0]!
 db.update(schema.recordEvent).set({year:2023,revision:2}).where(eq(schema.recordEvent.id,101)).run()
 expect(listRecordCorrespondences(db,{id})[0]).toMatchObject({requiresRevalidation:true,provenance:{event:{year:2022}}})
 const revalidate:CorrespondenceRequest={...request,idempotencyKey:'revalidate-source',operations:[{action:'revalidate',correspondenceId:id,expectedRevision:1}]}
 commitRecordCorrespondences(db,revalidate,preflightRecordCorrespondences(db,revalidate).planHash)
 expect(listRecordCorrespondences(db,{id})[0]).toMatchObject({relationId:109,status:'candidate',revision:2,requiresRevalidation:false,provenance:{event:{year:2023}}})
 expect(getRecordCorrespondenceAudit(db,id)).toMatchObject([{evidence:{event:{year:2022}}},{evidence:{event:{year:2023}}}])
 const confirm:CorrespondenceRequest={...request,idempotencyKey:'confirm-revalidated',operations:[{action:'decide',correspondenceId:id,expectedRevision:2,status:'confirmed'}]}
 commitRecordCorrespondences(db,confirm,preflightRecordCorrespondences(db,confirm).planHash)
 expect(listRecordCorrespondences(db,{id})[0]).toMatchObject({status:'confirmed',revision:3,requiresRevalidation:false})
})
it('keeps event export and process export context roles with nullable observation references',()=>{
 const request:CorrespondenceRequest={idempotencyKey:'export-contexts',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',operations:[{action:'create',status:'confirmed',edge:{type:'event_export_context',eventId:100,exportRowId:51,role:'current_snapshot_context'}},{action:'create',status:'confirmed',edge:{type:'process_export_context',relationId:109,exportRowId:51,role:'current_snapshot_context'}}]}
 const receipt=commitRecordCorrespondences(db,request,preflightRecordCorrespondences(db,request).planHash)
 const rows=receipt.correspondenceIds.map(id=>listRecordCorrespondences(db,{id})[0]!)
 expect(rows).toMatchObject([{relationId:null,eventId:100,exportRowId:51,requiresRevalidation:false},{relationId:109,exportRowId:51,requiresRevalidation:false}])
 expect(details(db,rows)).toMatchObject([{relation:null,event:{id:100},exportRow:{id:51}},{relation:{id:109,queryId:114},exportRow:{id:51}}])
 expect(t.pragma('foreign_key_check')).toEqual([])
})

it('batches structured source reads and avoids legacy mixed tables on the target',()=>{
 statements.length=0
 const rows=listRecordCorrespondences(db,{type:'later_process',status:'confirmed'})
 expect(rows.length).toBeGreaterThanOrEqual(2)
 expect(rows.every(row=>!row.requiresRevalidation)).toBe(true)
 expect(statements.filter(q=>/from "platform_business_projection"/i.test(q))).toHaveLength(1)
 expect(statements.filter(q=>/from "platform_apply_projection"/i.test(q))).toHaveLength(1)
 expect(statements.filter(q=>/from "platform_recognized_projection"/i.test(q))).toHaveLength(1)
 expect(statements.some(q=>/\b(?:from|join)\s+"platform_(?:query|relation)"(?:\s|$)/i.test(q))).toBe(false)
 expect(statements.some(q=>/"record_correspondence"\."relation_id"/.test(q))).toBe(false)
})


it('reuses shared current proof coverage within each page and refs request',()=>{
 const request:CorrespondenceRequest={idempotencyKey:'shared-proof',sourceIdentity:'745',actor:{type:'agent',id:'745'},basis:'normal',ruleId:'r',ruleVersion:'v',proofIds:[proofId],operations:[{action:'create',status:'confirmed',edge:{type:'recognized_export',relationId:201,exportRowId:52,role:'same_current_row'}}]}
 commitRecordCorrespondences(db,request,preflightRecordCorrespondences(db,request).planHash)
 const measure=(read:()=>unknown)=>{
  statements.length=0
  const result=read()
  return {result,proofReads:statements.filter(q=>/from "comparison_scope_proof"/i.test(q)).length,sourceReads:statements.filter(q=>/from "platform_recognized_projection"/i.test(q)).length}
 }
 const one=measure(()=>pageRecordCorrespondences(db,{relationId:201},{page:1,pageSize:1}))
 const two=measure(()=>pageRecordCorrespondences(db,{relationId:201},{page:1,pageSize:2}))
 expect(two.proofReads).toBeGreaterThan(0)
 expect(two.proofReads).toBe(one.proofReads)
 expect(two.sourceReads).toBe(one.sourceReads)
 const refs=measure(()=>listRecordCorrespondenceRefs(db,{relationId:201}))
 expect(refs.result).toMatchObject([{requiresRevalidation:false},{requiresRevalidation:false}])
 expect(refs.proofReads).toBe(one.proofReads)
 expect(refs.sourceReads).toBe(one.sourceReads)
 const readRefs=createEnterpriseTitleCorrespondenceRefsReader(db)
 expect(readRefs(1,'specialized_sme').filter(row=>row.relationId===201)).toMatchObject([{requiresRevalidation:false},{requiresRevalidation:false}])
 const revoke:ProofRequest={...currentProofRequest,idempotencyKey:'shared-proof-revoke',operations:[{action:'decide',proofId,expectedRevision:2,status:'revoked'}]}
 commitComparisonScopeProofs(db,revoke,preflightComparisonScopeProofs(db,revoke).planHash)
 expect(readRefs(1,'specialized_sme').filter(row=>row.relationId===201)).toMatchObject([{requiresRevalidation:true},{requiresRevalidation:true}])
 expect(listRecordCorrespondenceRefs(db,{relationId:201})).toMatchObject([{requiresRevalidation:true},{requiresRevalidation:true}])
})
