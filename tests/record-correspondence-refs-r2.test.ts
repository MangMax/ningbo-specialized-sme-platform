import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { useDb, schema as s } from '../db/client'
import { preflightComparisonScopeProofs, commitComparisonScopeProofs } from '../server/utils/comparison-scope-proof'
import { preflightRecordCorrespondences, commitRecordCorrespondences, getRecordCorrespondence, listRecordCorrespondenceRefs, type CorrespondenceRequest, type CorrespondenceEdge } from '../server/utils/record-correspondence'

const cleanup: Array<()=>void> = []
afterEach(()=>{for(const close of cleanup.splice(0).reverse()) close()})
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'refs-r2-'))
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const db=useDb({dbPath:join(dir,'synthetic.db')})
  cleanup.push(()=>db.$client.close())
  const enterprise=db.insert(s.enterprise).values({name:'合成身份企业',nameNorm:'合成身份企业',usccNorm:'91330200123456789A'}).returning().get()
  return {db,enterprise}
}
function confirm(db:ReturnType<typeof useDb>, key:string, edge:CorrespondenceEdge, proofIds?:number[]) {
  const request:CorrespondenceRequest={idempotencyKey:key,sourceIdentity:'synthetic',actor:{type:'user',id:'reviewer'},basis:'explicit synthetic identity and scope',ruleId:'manual',ruleVersion:'1',proofIds,operations:[{action:'create',status:'confirmed',edge}]}
  const plan=preflightRecordCorrespondences(db,request)
  return commitRecordCorrespondences(db,request,plan.planHash).correspondenceIds[0]!
}
/** Meter real driver values without changing statements or results. */
function meter(db:ReturnType<typeof useDb>, marker:string) {
  let rawBytes=0, stringBytes=0
  const prepare=db.$client.prepare.bind(db.$client)
  const count=(v:unknown):void=>{if(typeof v==='string'){stringBytes+=Buffer.byteLength(v);if(v.includes(marker))rawBytes+=Buffer.byteLength(v)}else if(v&&typeof v==='object')Object.values(v).forEach(count)}
  db.$client.prepare=((sql:string)=>{const st=prepare(sql);for(const method of ['get','all'] as const){const run=st[method].bind(st);Object.assign(st,{[method]:(...args:unknown[])=>{const result=run(...args);count(result);return result}})}return st}) as typeof prepare
  return {get rawBytes(){return rawBytes},get stringBytes(){return stringBytes},restore(){db.$client.prepare=prepare}}
}
it('后续流程各角色在未分配及已分配身份模式下与完整读取一致且不物化原文',()=>{
  const {db,enterprise:e}=fixture(), marker='ARCHIVED_IDENTITY_'
  const q=db.insert(s.platformQuery).values({interface:'business_list',queryKey:e.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-10-19',status:'success',rawResponse:marker+'x'.repeat(1024*1024)}).returning({id:s.platformQuery.id}).get()
  const cases:Array<{role:Extract<CorrespondenceEdge,{type:'later_process'}>['role'];mode:'unassigned_uscc'|'assigned_uscc'|'assigned_no_uscc';id:number}>=[]
  for(const role of ['followup_apply','followup_update','followup_review'] as const) for(const mode of ['unassigned_uscc','assigned_uscc','assigned_no_uscc'] as const){
    const r=db.insert(s.platformRelation).values({queryId:q.id,sequenceNo:cases.length+1,enterpriseId:mode==='unassigned_uscc'?null:e.id,usccRaw:mode==='assigned_no_uscc'?null:e.usccNorm,declareKind:role.replace('followup_','') as 'apply'|'update'|'review',verificationStatus:'confirmed'}).returning().get()
    cases.push({role,mode,id:confirm(db,role+mode,{type:'later_process',enterpriseId:e.id,titleCode:'specialized_sme',relationId:r.id,role})})
  }
  const check=(code:string|null,changed:boolean)=>{
    db.$client.prepare('update enterprise set uscc_norm=? where id=?').run(code,e.id)
    for(const c of cases){
      const expected=changed&&c.mode!=='assigned_no_uscc'&&(code!=null||c.mode==='unassigned_uscc')
      expect(getRecordCorrespondence(db,c.id)!.requiresRevalidation,c.role+c.mode).toBe(expected)
      const observed=meter(db,marker)
      try{expect(listRecordCorrespondenceRefs(db,{id:c.id})[0]!.requiresRevalidation,c.role+c.mode).toBe(expected);expect(observed.rawBytes).toBe(0);expect(observed.stringBytes).toBeLessThan(65536)}finally{observed.restore()}
    }
  }
  check(e.usccNorm,false)
  check('91330200987654321B',true)
  check(null,true)
  check(e.usccNorm,false)
})

function mixedProofFixture(options: {queryRaw?:string;duplicateCurrent?:boolean;unrelatedCurrent?:boolean} = {}) {
 const {db,enterprise:e}=fixture()
 const raw='ARCHIVED_OFFICIAL_'+'x'.repeat(1024*1024)
 const r=db.insert(s.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:raw}).returning().get()
 const ev=db.insert(s.recordEvent).values({recordId:r.id,eventType:'award',year:2024}).returning().get()
 const officialFile=db.insert(s.storedFile).values({relPath:'synthetic/notice.pdf',filename:'notice.pdf',ext:'pdf',bytes:8,sha256:'a'.repeat(64),source:'jxj',kind:'announcement'}).returning().get()
 const doc=db.insert(s.sourceDocument).values({source:'jxj',title:'Synthetic notice',path:officialFile.relPath}).returning().get()
 db.insert(s.recordEvidence).values({recordEventId:ev.id,sourceFile:doc.path,page:3,listNo:2}).run()
 const conditions={combination:'and' as const}
 const collection:NonNullable<typeof s.platformQuery.$inferInsert.collectionEvidence>={source:'queryBusList',status:'success',effectiveConditions:conditions,titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-10-18T00:00:00Z',completedAt:'2026-10-18T00:01:00Z',rows:[],pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
 const q=db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:'all',rdjb:'2',titleCode:'specialized_sme',queriedAt:collection.queriedAt,status:'success',collectionEvidence:collection,rawResponse:options.queryRaw}).returning().get()
 const rel=db.insert(s.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId:e.id,usccRaw:e.usccNorm,nameRaw:e.name,verificationStatus:'confirmed'}).returning().get()
 const batch=db.insert(s.platformExportBatch).values({titleCode:'specialized_sme',year:2026,collectedOn:'2026-10-18',originalFilename:'synthetic.xlsx',sha256:'b'.repeat(64),importStatus:'imported'}).returning().get()
 const er=db.insert(s.platformExportRow).values({batchId:batch.id,sourceRowNo:1,usccRaw:e.usccNorm,nameRaw:e.name}).returning().get()
 const freeze=db.insert(s.storedFile).values({relPath:'synthetic/freeze-v1',filename:'freeze-v1.txt',ext:'txt',bytes:24,sha256:'c'.repeat(64),source:'miit',kind:'export'}).returning().get()
 const common={sourceIdentity:'synthetic',actor:{type:'user',id:'reviewer'},basis:'explicit synthetic scope',ruleId:'manual',ruleVersion:'1'}
 const pr:any={...common,idempotencyKey:'combined-proofs',operations:[
  {action:'create',kind:'official_coverage',status:'confirmed',evidence:{titleCode:'specialized_sme',fromYear:2024,throughYear:2024,enterpriseIds:null,fullRange:true,sourceDocuments:[{id:doc.id,fileId:officialFile.id,sha256:officialFile.sha256,reference:{field:'source_document.path'}}]}},
  {action:'create',kind:'current_source_equivalence',status:'confirmed',evidence:{queryId:q.id,exportBatchId:batch.id,titleCode:'specialized_sme',queryReference:'platform_query.collectionEvidence',exportReference:'platform_export_batch.sha256',scope:{queryAccount:'synthetic',exportAccount:'synthetic',queryRegion:'synthetic',exportRegion:'synthetic',queryFilters:conditions,exportFilters:conditions,windowStart:'2026-10-18T00:00:00Z',windowEnd:'2026-10-18T23:59:59Z',platformVersion:'freeze-v1',freezeReference:freeze.relPath,freezeFileId:freeze.id,freezeSha256:freeze.sha256}}}
 ]}
 if (options.duplicateCurrent) pr.operations.push(pr.operations[1])
 if (options.unrelatedCurrent) {
   const otherQuery=db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:'unrelated',rdjb:'2',titleCode:'specialized_sme',queriedAt:collection.queriedAt,status:'success',collectionEvidence:collection,rawResponse:'ARCHIVED_UNRELATED_'+'x'.repeat(1024*1024)}).returning({id:s.platformQuery.id}).get()
   pr.operations.push({...pr.operations[1],evidence:{...pr.operations[1].evidence,queryId:otherQuery.id}})
 }
 const pp=preflightComparisonScopeProofs(db,pr),proofIds=commitComparisonScopeProofs(db,pr,pp.planHash).proofIds
 const id=confirm(db,'mixed-proof-edge',{type:'recognized_export',relationId:rel.id,exportRowId:er.id,role:'same_current_row'},proofIds)

 return {db,id,proofIds,q,rel,batch,er,freeze,officialFile}
}
it('混合正式覆盖与当前等价凭据只复验相关当前来源且不读取正式大原文',()=>{
 const {db,id}=mixedProofFixture()
 expect(getRecordCorrespondence(db,id)!.requiresRevalidation).toBe(false)
 const observed=meter(db,'ARCHIVED_OFFICIAL_')
 try {
   expect(listRecordCorrespondenceRefs(db,{id})[0]!.requiresRevalidation).toBe(false)
   expect(observed.rawBytes).toBe(0)
   expect(observed.stringBytes).toBeLessThan(65536)
   console.log(JSON.stringify({case:'mixed-proof',officialRawBytes:observed.rawBytes,driverStringBytes:observed.stringBytes}))
 } finally {observed.restore()}
})

it('正式事件流程认定行与导出四种来源的各角色保持当前身份复验语义',()=>{
  const {db,enterprise:e}=fixture()
  const record=db.insert(s.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj'}).returning().get()
  const award=db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2024}).returning().get()
  const review=db.insert(s.recordEvent).values({recordId:record.id,eventType:'review',year:2021,decidedYear:2024,reviewOutcome:'passed'}).returning().get()
  const batch=db.insert(s.platformExportBatch).values({titleCode:'specialized_sme',year:2026,collectedOn:'2026-10-18',originalFilename:'synthetic.xlsx',sha256:'b'.repeat(64),importStatus:'imported'}).returning().get()
  const exported=db.insert(s.platformExportRow).values({batchId:batch.id,sourceRowNo:1,usccRaw:e.usccNorm}).returning().get()
  const cases:Array<{id:number;onChanged:boolean;onMissing:boolean}>=[]
  for(const assigned of [false,true]) {
    const process=db.insert(s.platformQuery).values({interface:'business_list',queryKey:e.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:assigned?'2026-10-19T01:00:00Z':'2026-10-19T00:00:00Z',status:'success'}).returning().get()
    const recognized=db.insert(s.platformQuery).values({interface:'recognized_list',queryKey:e.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:assigned?'2026-10-19T01:00:00Z':'2026-10-19T00:00:00Z',status:'success'}).returning().get()
    const relation=(queryId:number)=>db.insert(s.platformRelation).values({queryId,sequenceNo:1,enterpriseId:assigned?e.id:null,usccRaw:'\u200b'+e.usccNorm!.toLowerCase()+'\u3000',verificationStatus:'confirmed'}).returning().get()
    const pr=relation(process.id),rr=relation(recognized.id)
    for(const role of ['supports_award','supports_review','context_only'] as const) cases.push({id:confirm(db,role+assigned,{type:'event_process',eventId:role==='supports_review'?review.id:award.id,relationId:pr.id,role}),onChanged:true,onMissing:true})
    for(const role of ['recognized_corrob','current_context'] as const) cases.push({id:confirm(db,role+assigned,{type:'event_recognized',eventId:award.id,relationId:rr.id,role}),onChanged:true,onMissing:true})
    cases.push({id:confirm(db,'process-export'+assigned,{type:'process_export_context',relationId:pr.id,exportRowId:exported.id,role:'current_snapshot_context'}),onChanged:assigned,onMissing:false})
  }
  cases.push({id:confirm(db,'event-export',{type:'event_export_context',eventId:award.id,exportRowId:exported.id,role:'current_snapshot_context'}),onChanged:true,onMissing:true})
  for(const code of [e.usccNorm,'91330200987654321B',null,e.usccNorm]){
    db.$client.prepare('update enterprise set uscc_norm=? where id=?').run(code,e.id)
    for(const c of cases){
      const expected=code===e.usccNorm?false:code==null?c.onMissing:c.onChanged
      expect(getRecordCorrespondence(db,c.id)!.requiresRevalidation,'detail '+c.id).toBe(expected)
      expect(listRecordCorrespondenceRefs(db,{id:c.id})[0]!.requiresRevalidation,'refs '+c.id).toBe(expected)
    }
  }
})

it('当前等价凭据预算覆盖冻结文件与审计并保留来源变化撤销和超预算需重核实',()=>{
  const {db,id,q,freeze,proofIds,officialFile}=mixedProofFixture()
  const assertRef=(expected:boolean,marker='ARCHIVED_BUDGET_')=>{
    const observed=meter(db,marker)
    try{expect(listRecordCorrespondenceRefs(db,{id})[0]!.requiresRevalidation).toBe(expected);expect(observed.rawBytes).toBe(0)}finally{observed.restore()}
  }
  // Official coverage is irrelevant even if its original file is removed.
  db.$client.prepare('update stored_file set removed_at=? where id=?').run('2026-10-19',officialFile.id)
  expect(getRecordCorrespondence(db,id)!.requiresRevalidation).toBe(false)
  assertRef(false)
  // Full current-source validation reads the entire freeze row, not only its hash.
  db.$client.prepare('update stored_file set filename=? where id=?').run('ARCHIVED_BUDGET_'+'x'.repeat(1024*1024),freeze.id)
  expect(getRecordCorrespondence(db,id)!.requiresRevalidation).toBe(false)
  assertRef(true)
  db.$client.prepare('update stored_file set filename=? where id=?').run(freeze.filename,freeze.id)
  assertRef(false)
  // Proof status reads all audit rows. Those rows are part of the real read set.
  db.$client.prepare('update comparison_scope_proof_audit set basis=? where proof_id=?').run('ARCHIVED_BUDGET_'+'x'.repeat(1024*1024),proofIds[1])
  assertRef(true)
  db.$client.prepare('update comparison_scope_proof_audit set basis=? where proof_id=?').run('restored synthetic basis',proofIds[1])
  assertRef(false)
  db.$client.prepare('update platform_query set raw_response=? where id=?').run('ARCHIVED_BUDGET_'+'x'.repeat(1024*1024),q.id)
  assertRef(true)
  db.$client.prepare('update platform_query set raw_response=null where id=?').run(q.id)
  assertRef(false)
  db.$client.prepare('update stored_file set sha256=? where id=?').run('d'.repeat(64),freeze.id)
  expect(getRecordCorrespondence(db,id)!.requiresRevalidation).toBe(true)
  assertRef(true)
  db.$client.prepare('update stored_file set sha256=? where id=?').run(freeze.sha256,freeze.id)
  assertRef(false)
  const request={idempotencyKey:'revoke-current-proof',sourceIdentity:'synthetic',actor:{type:'user' as const,id:'reviewer'},basis:'withdraw current equivalence',ruleId:'manual',ruleVersion:'1',operations:[{action:'decide' as const,proofId:proofIds[1]!,expectedRevision:2,status:'revoked' as const}]}
  const plan=preflightComparisonScopeProofs(db,request)
  commitComparisonScopeProofs(db,request,plan.planHash)
  expect(getRecordCorrespondence(db,id)!.requiresRevalidation).toBe(true)
  assertRef(true)
})

it('混合凭据忽略其他端点大来源而重复相关凭据按实际重复读取计量',()=>{
 const unrelated=mixedProofFixture({unrelatedCurrent:true})
 const observed=meter(unrelated.db,'ARCHIVED_UNRELATED_')
 try{expect(listRecordCorrespondenceRefs(unrelated.db,{id:unrelated.id})[0]!.requiresRevalidation).toBe(false);expect(observed.rawBytes).toBe(0);expect(observed.stringBytes).toBeLessThan(65536)}finally{observed.restore()}
 // Each relevant source set fits alone; two independent attestations would
 // re-read the same 32KiB archive twice through the full proof service.
 const repeated=mixedProofFixture({queryRaw:'ARCHIVED_REPEATED_'+'x'.repeat(32*1024),duplicateCurrent:true})
 expect(getRecordCorrespondence(repeated.db,repeated.id)!.requiresRevalidation).toBe(false)
 const duplicateMeter=meter(repeated.db,'ARCHIVED_REPEATED_')
 try{expect(listRecordCorrespondenceRefs(repeated.db,{id:repeated.id})[0]!.requiresRevalidation).toBe(true);expect(duplicateMeter.rawBytes).toBe(0)}finally{duplicateMeter.restore()}
})
