import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import { identityFunctions } from '../lib/roster/enterprise-read-snapshot'
import { readAnnualComparisonBatch } from '../server/utils/event-annual-process-read'
import { readPlatformComparisonProcesses } from '../server/utils/platform-comparison-input'

function fixture428Input() {
  const sqlite = new Database(':memory:'); sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite,{schema}); identityFunctions(db); migrate(db,{migrationsFolder:'db/migrations'}); db.insert(schema.title).values([...TITLE_SEED]).run()
  const e = db.insert(schema.enterprise).values({name:'Adapter428',nameNorm:'Adapter428',usccNorm:'91330211255994457P'}).returning().get()
  const r = db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',usccRaw:e.usccNorm}).returning().get()
  const event = db.insert(schema.recordEvent).values({recordId:r.id,eventType:'award',year:2024}).returning().get()
  const query = (extra: Partial<typeof schema.platformQuery.$inferInsert> = {}) => db.insert(schema.platformQuery).values({interface:'business_list',queryKey:e.usccNorm!,titleCode:'specialized_sme',rdjb:'2',queriedAt:'2026-05-31T00:00:00Z',status:'success',...extra}).returning().get()
  const row = (queryId:number, sequenceNo=1, extra: Partial<typeof schema.platformRelation.$inferInsert> = {}) => db.insert(schema.platformRelation).values({queryId,sequenceNo,relationKey:`B${sequenceNo}`,enterpriseId:e.id,usccRaw:e.usccNorm,verificationStatus:'confirmed',matchBasis:'uscc',rawFields:{sblx:'申请',year:'2024',sqsj:'2024-03-01',cszt:'终审通过'},...extra}).returning().get()
  const request = (selectedQueryIds:number[]) => ({enterpriseId:e.id,titleCode:'specialized_sme',eventIds:[event.id],selectedQueryIds})
  const batch = (selectedQueryIds:number[]) => sqlite.transaction(()=>readAnnualComparisonBatch(sqlite,db,request(selectedQueryIds)))()
  return {sqlite,db,e,event,query,row,request,batch}
}
it('C1_unselected_normalized_USCC_history_query_is_scope_unavailable',()=>{
  const f=fixture428Input();try {
    const selected=f.query();f.row(selected.id)
    const omitted=f.query({queryKey:'name:未登记历史名',queriedAt:'2026-05-31T00:00:01Z'});f.row(omitted.id,1,{enterpriseId:null,usccRaw:'91330211\u200b255994457p'})
    expect(()=>f.batch([selected.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('C2_protected_indexed_history_outside_selected_queries_is_scope_unavailable',()=>{
  const f=fixture428Input();try {
    const q=f.query();const row=f.row(q.id)
    const old=f.query({queryKey:'name:other',rdjb:'1',titleCode:'innovative_sme',queriedAt:'2025-01-01T00:00:00Z'})
    const h=f.row(old.id,1,{enterpriseId:null,usccRaw:'other'})
    const b=f.db.insert(schema.platformBusinessRecord).values({interface:'business_list',platformKey:'B1',identityRuleVersion:'fixture'}).returning().get()
    for(const id of [row.id,h.id]) f.db.insert(schema.platformBusinessObservation).values({relationId:id,recordId:b.id,versionId:null,identityState:'resolved',contentState:'unverifiable',keySource:'relation_key',projectionRuleVersion:'fixture',inputFingerprint:'fixture'}).run()
    expect(()=>f.batch([q.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('C3_actual_archived_rows_cannot_exceed_successful_page_count',()=>{
  const f=fixture428Input();try {
    const q=f.query({collectionEvidence:{pages:[{status:'success',fetchedCount:1}],completeness:'complete',fullRange:true} as never})
    f.row(q.id);f.row(q.id,2,{enterpriseId:null,usccRaw:'unrelated'})
    expect(()=>f.batch([q.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('C3_sequence_gap_cannot_be_hidden_by_equal_row_count',()=>{
  const f=fixture428Input();try {
    const q=f.query({collectionEvidence:{pages:[{status:'success',fetchedCount:2}],completeness:'complete',fullRange:true} as never});f.row(q.id);f.row(q.id,3)
    expect(()=>f.batch([q.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('closed_partial_scope_is_assembled_without_fabricated_confirmation',()=>{
  const f=fixture428Input();try {
    const q=f.query({status:'partial',collectionEvidence:{pages:[{status:'success',fetchedCount:1}],completeness:'partial',fullRange:false} as never});f.row(q.id)
    const out=f.batch([q.id]);expect(out.entries).toHaveLength(1);expect(out.entries[0]!.input.coverage).toEqual([{queryId:q.id,interface:'business_list',queriedAt:'2026-05-31T00:00:00Z',status:'partial',completeness:'partial',fullRange:false}])
    expect(out.entries[0]!.read.process.finalQualification).toBeUndefined()
    const qualified = f.sqlite.transaction(() => readPlatformComparisonProcesses(f.sqlite, f.request([q.id])))()
    expect(qualified).toHaveLength(1)
    expect(qualified[0]!.finalQualification).toBeDefined()
    expect(qualified[0]!.finalQualification).not.toBeNull()
    expect(qualified[0]!.finalQualification!.status).not.toBe('confirmed')
    expect(out.admission.actualSourceBytes[0]).toBeLessThanOrEqual(out.admission.sourceUpperBytes[0]!)
  }finally{f.sqlite.close()}
})
it('actual_SQL_rows_65_rejected_before_hydration',()=>{
  const f=fixture428Input();try {const q=f.query();for(let i=1;i<=65;i++)f.row(q.id,i)
    expect(()=>f.batch([q.id])).toThrow('input_resource_limit')
  }finally{f.sqlite.close()}
})
it('actual_SQL_rows_64_remain_in_complete_scope',()=>{
  const f=fixture428Input();try {const q=f.query();for(let i=1;i<=64;i++)f.row(q.id,i)
    const out=f.batch([q.id]);expect(out.entries[0]!.read.sourceRefs.observations).toHaveLength(64)
    expect(out.admission.expandedCharge).toBeLessThanOrEqual(16777216)
  }finally{f.sqlite.close()}
})
it('adapter_missing_event_throws_without_Z_or_empty_fallback',()=>{
  const f=fixture428Input();try {expect(()=>f.sqlite.transaction(()=>readPlatformComparisonProcesses(f.sqlite,{...f.request([]),eventIds:[999]}))()).toThrow('platform_comparison_scope_unavailable')}
  finally{f.sqlite.close()}
})
it('actual_SQL_raw7_4097_rejected_before_normalization',()=>{
  const f=fixture428Input();try {const q=f.query();f.row(q.id,1,{rawFields:{cszt:'x'.repeat(4063)}})
    // Seven slots: six nulls (24), six commas (6), brackets (2), string quotes (2).
    expect(()=>f.batch([q.id])).toThrow('input_resource_limit')
  }finally{f.sqlite.close()}
})
it('explicit_comparison_requires_owning_snapshot',()=>{
  const f=fixture428Input();try {expect(()=>readPlatformComparisonProcesses(f.sqlite,f.request([]))).toThrow('platform_comparison_scope_unavailable')}
  finally{f.sqlite.close()}
})

it('C3_complete_pages_1_3_are_scope_unavailable_before_hydration',()=>{
  const f=fixture428Input();try {
    const q=f.query({collectionEvidence:{pages:[{source:'businessList',rdjb:'2',page:1,status:'success',fetchedCount:1},{source:'businessList',rdjb:'2',page:3,status:'success',fetchedCount:1}],completeness:'complete',fullRange:true} as never})
    f.row(q.id);f.row(q.id,2)
    expect(()=>f.batch([q.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('C3_complete_string_page_number_is_scope_unavailable',()=>{
  const f=fixture428Input();try {
    const q=f.query({collectionEvidence:{pages:[{source:'businessList',rdjb:'2',page:'1',status:'success',fetchedCount:1}],completeness:'complete',fullRange:true} as never});f.row(q.id)
    expect(()=>f.batch([q.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('proofIds_object_is_scope_unavailable_before_decision_hydration',()=>{
  const f=fixture428Input();try {
    const q=f.query();const row=f.row(q.id)
    f.db.insert(schema.recordCorrespondence).values({edgeKey:'bad-proof-428',type:'event_process',role:'supports_award',eventId:f.event.id,relationId:row.id,enterpriseId:f.e.id,titleCode:'specialized_sme',status:'candidate',revision:1,targetIdentity:{},provenance:{comparisonProofIds:{id:1}},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:'2026-01-01T00:00:00Z'}).run()
    expect(()=>f.batch([q.id])).toThrow('platform_comparison_scope_unavailable')
  }finally{f.sqlite.close()}
})
it('F_two_events_hydrate_evidence_once_after_admission',()=>{
  const f=fixture428Input();try {
    const second=f.db.insert(schema.recordEvent).values({recordId:f.event.recordId,eventType:'award',year:2023}).returning().get()
    for(const id of [f.event.id,second.id])f.db.insert(schema.recordEvidence).values({recordEventId:id,sourceFile:'合成.txt',listNo:id}).run()
    const q=f.query();f.row(q.id)
    const statements:string[]=[]
    const traced=drizzle(f.sqlite,{schema,logger:{logQuery(query){statements.push(query)}}})
    const out=f.sqlite.transaction(()=>readAnnualComparisonBatch(f.sqlite,traced,{...f.request([q.id]),eventIds:[f.event.id,second.id]}))()
    expect(out.entries.map(e=>e.read.sourceRefs.evidence.length)).toEqual([1,1])
    const hydration=statements.filter(s=>s.startsWith('select ')&&s.includes('from "record_evidence"'))
    expect(hydration).toHaveLength(1)
  }finally{f.sqlite.close()}
})

// #428 absence negatives: real SQLite sources/decisions, no fabricated core verdict.
function recognizedZero428() {
  return { source:'queryBusList',status:'no_record',completeness:'complete',fullRange:true,
    unfinished:[],error:null,pages:[{source:'queryBusList',rdjb:'2',page:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}] }
}
function assertAbsence428(f:ReturnType<typeof fixture428Input>, ids:number[], absent:boolean) {
  f.sqlite.pragma('query_only=ON')
  const changes=f.sqlite.prepare('select total_changes() n').get()
  try {
    const batch=f.batch(ids)
    expect(batch.kind).toBe(absent?'absent':'present')
    const processes=f.sqlite.transaction(()=>readPlatformComparisonProcesses(f.sqlite,f.request(ids)))()
    expect(processes).toHaveLength(absent?0:1)
    return {batch,processes}
  } finally {
    expect(f.sqlite.prepare('select total_changes() n').get()).toEqual(changes)
    expect(f.sqlite.pragma('query_only',{simple:true})).toBe(1)
  }
}
function assertUnavailable428(f:ReturnType<typeof fixture428Input>, ids:number[]) {
  f.sqlite.pragma('query_only=ON')
  const changes=f.sqlite.prepare('select total_changes() n').get()
  try {
    expect(()=>f.batch(ids)).toThrowError(new Error('platform_comparison_scope_unavailable'))
    expect(()=>f.sqlite.transaction(()=>readPlatformComparisonProcesses(f.sqlite,f.request(ids)))()).toThrowError(new Error('platform_comparison_scope_unavailable'))
  } finally {
    expect(f.sqlite.prepare('select total_changes() n').get()).toEqual(changes)
    expect(f.sqlite.pragma('query_only',{simple:true})).toBe(1)
  }
}
it('absence428_no_queries',()=>{
  const f=fixture428Input();try{assertAbsence428(f,[],true)}finally{f.sqlite.close()}
})
it.each(['partial','failed','not_queried','missing','unfinished','unknown','primitive_page','missing_error'] as const)('absence428_metadata_%s',kind=>{
  const f=fixture428Input();try{
    const metadata:Record<string,unknown>=recognizedZero428()
    let status:'no_record'|'partial'|'failed'|'not_queried'='no_record'
    if(kind==='partial'||kind==='failed'||kind==='not_queried'){status=kind;metadata.status=kind}
    if(kind==='unfinished')metadata.unfinished=[{source:'queryBusList',rdjb:'2',page:2}]
    if(kind==='unknown')metadata.completeness='future-protocol'
    if(kind==='primitive_page')metadata.pages=['not-an-object']
    if(kind==='missing_error')delete metadata.error
    const q=f.query({interface:'recognized_list',status,collectionEvidence:kind==='missing'?null:metadata as never})
    assertAbsence428(f,[q.id],true)
  }finally{f.sqlite.close()}
})
it.each(['unlinked','rejected','candidate','ended','predecessor','owner'] as const)('absence428_decision_%s',kind=>{
  const f=fixture428Input();try{
    f.db.insert(schema.recordCorrespondence).values({edgeKey:`absence-${kind}`,type:'event_process',role:'supports_award',
      eventId:kind==='predecessor'||kind==='owner'?null:f.event.id,
      predecessorEventId:kind==='predecessor'?f.event.id:null,
      enterpriseId:kind==='owner'?f.e.id:null,titleCode:'specialized_sme',
      status:kind==='unlinked'||kind==='rejected'?kind:'candidate',endedAt:kind==='ended'?'2026-01-02T00:00:00Z':null,
      revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:'2026-01-01T00:00:00Z'}).run()
    assertUnavailable428(f,[])
  }finally{f.sqlite.close()}
})
it.each(['future','retry','tie','potential_later','unknown_normalization'] as const)('absence428_business_%s',kind=>{
  const f=fixture428Input();try{
    const q=f.query({queriedAt:kind==='future'?'2027-01-01T00:00:00Z':'2026-05-31T00:00:00Z'});f.row(q.id)
    const ids=[q.id]
    if(kind==='retry'||kind==='tie') {
      const secondAt=kind==='retry'?'2026-06-01T00:00:00Z':'2026-05-31T08:00:00+08:00'
      if(kind==='tie') {
        expect(secondAt).not.toBe(q.queriedAt)
        expect(Date.parse(secondAt)).toBe(Date.parse(q.queriedAt))
      }
      const second=f.query({queriedAt:secondAt});f.row(second.id);ids.push(second.id)
    }
    if(kind==='potential_later'||kind==='unknown_normalization')f.row(q.id,2,{rawFields:kind==='potential_later'?{sblx:'申请',sqsj:'2024-12-01',cszt:'审核中'}:{sblx:'未来业务',year:'未知',cszt:'未映射状态'}})
    const out=assertAbsence428(f,ids,false)
    expect(out.batch.entries[0]!.read.sourceRefs.observations.length).toBeGreaterThan(0)
  }finally{f.sqlite.close()}
})
it('absence428_unlinked_apply_unknown_title',()=>{
  const f=fixture428Input();try{
    const q=f.query({interface:'apply_list',titleCode:null,rdjb:''});f.row(q.id)
    const out=assertAbsence428(f,[q.id],false)
    expect(out.processes[0]!.input.scopeGaps?.map(g=>g.reasons)).toEqual([['title_scope_unknown']])
  }finally{f.sqlite.close()}
})
it('absence428_cross_history_rejected',()=>{
  const f=fixture428Input();try{
    const q=f.query(),old=f.query({queriedAt:'2025-01-01T00:00:00Z'}),row=f.row(q.id),history=f.row(old.id)
    const record=f.db.insert(schema.platformBusinessRecord).values({interface:'business_list',platformKey:'B1',identityRuleVersion:'fixture'}).returning().get()
    for(const relation of [row,history])f.db.insert(schema.platformBusinessObservation).values({relationId:relation.id,recordId:record.id,versionId:null,identityState:'resolved',contentState:'unverifiable',keySource:'relation_key',projectionRuleVersion:'fixture',inputFingerprint:'fixture'}).run()
    f.db.insert(schema.recordCorrespondence).values({edgeKey:'absence-history',type:'event_process',role:'supports_award',eventId:f.event.id,relationId:history.id,enterpriseId:f.e.id,titleCode:'specialized_sme',status:'rejected',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:'2026-01-01T00:00:00Z'}).run()
    const out=assertAbsence428(f,[q.id,old.id],false)
    expect(out.batch.history.get(record.id)?.slice().sort((a,b)=>a-b)).toEqual([row.id,history.id])
    expect(out.processes[0]!.currentDecisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({status:'rejected',relationId:history.id})]))
  }finally{f.sqlite.close()}
})
it('absence428_closure_error_before_omission',()=>{
  const f=fixture428Input();try{f.query();expect(()=>f.batch([])).toThrowError(new Error('platform_comparison_scope_unavailable'))}finally{f.sqlite.close()}
})
it('absence428_resource_error_before_omission',()=>{
  const f=fixture428Input();try{expect(()=>f.sqlite.transaction(()=>readAnnualComparisonBatch(f.sqlite,f.db,{...f.request([]),eventIds:Array.from({length:41},(_,i)=>i+1)}))()).toThrowError(new Error('input_resource_limit'))}finally{f.sqlite.close()}
})

it.each(['none','partial','failed','unknown','query','history','decision'] as const)('absence428_null_award_%s',kind=>{
  const f=fixture428Input();try{
    // Formal authority retains raw null; decidedYear is not a replacement for year.
    f.sqlite.prepare('update record_event set year=NULL, decided_year=2024 where id=?').run(f.event.id)
    const ids:number[]=[]
    if(kind==='partial'||kind==='failed'||kind==='unknown'||kind==='query') {
      const q=f.query({status:kind==='partial'||kind==='failed'?kind:'success',collectionEvidence:null})
      ids.push(q.id)
      if(kind==='unknown')f.row(q.id,1,{rawFields:{sblx:'未来类型',cszt:'未知状态'}})
    }
    if(kind==='history') {
      const q=f.query(),old=f.query({queriedAt:'2025-01-01T00:00:00Z'});ids.push(q.id,old.id)
      const a=f.row(q.id),b=f.row(old.id)
      const record=f.db.insert(schema.platformBusinessRecord).values({interface:'business_list',platformKey:'null-year-history',identityRuleVersion:'fixture'}).returning().get()
      for(const row of [a,b])f.db.insert(schema.platformBusinessObservation).values({relationId:row.id,recordId:record.id,versionId:null,identityState:'resolved',contentState:'unverifiable',keySource:'relation_key',projectionRuleVersion:'fixture',inputFingerprint:'fixture'}).run()
    }
    if(kind==='decision')f.db.insert(schema.recordCorrespondence).values({edgeKey:'null-year-protected',type:'event_process',role:'supports_award',eventId:f.event.id,enterpriseId:f.e.id,titleCode:'specialized_sme',status:'rejected',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:'2026-01-01T00:00:00Z'}).run()
    if(kind==='partial'||kind==='failed'||kind==='query'||kind==='decision')assertUnavailable428(f,ids)
    else {
      const out=assertAbsence428(f,ids,kind==='none')
      if(kind==='none')expect(out.batch.entries).toEqual([])
      else {
        expect(out.batch.entries[0]!.input.event.year).toBeNull()
        expect(out.batch.entries[0]!.input.event.decidedYear).toBe(2024)
      }
      if(kind==='history')expect([...out.batch.history.values()][0]).toHaveLength(2)
    }
    expect(f.sqlite.prepare('select year,decided_year from record_event where id=?').get(f.event.id)).toEqual({year:null,decided_year:2024})
  }finally{f.sqlite.close()}
})

it.each(['complete','partial','failed','missing','unknown'] as const)('split428_apply_zero_%s',kind=>{
  const f=fixture428Input();try {
    const evidence={source:'queryList',status:kind==='failed'?'failed':'no_record',completeness:kind==='complete'?'complete':kind==='unknown'?'future-protocol':'partial',fullRange:true,
      titleScope:{mode:'source_default',rdjb:[]},unfinished:[],error:null,pages:[{source:'queryList',rdjb:null,page:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}]}
    const q=f.query({interface:'apply_list',titleCode:null,rdjb:'',status:kind==='failed'?'failed':'no_record',collectionEvidence:kind==='missing'?null:evidence as never})
    if(kind==='complete')assertAbsence428(f,[q.id],true)
    else assertUnavailable428(f,[q.id])
  }finally{f.sqlite.close()}
})
it('split428_business_unknown_title_row_is_not_empty',()=>{
  const f=fixture428Input();try{
    const q=f.query({titleCode:null,rdjb:''});f.row(q.id)
    const out=assertAbsence428(f,[q.id],false)
    expect(out.processes[0]!.input.scopeGaps?.map(g=>g.reasons)).toEqual([['title_scope_unknown']])
  }finally{f.sqlite.close()}
})
it('split428_zero_metadata_cannot_hide_other_owner_archive',()=>{
  const f=fixture428Input();try{
    const q=f.query({interface:'apply_list',titleCode:null,rdjb:'',status:'no_record',collectionEvidence:{source:'queryList',status:'no_record',completeness:'complete',fullRange:true,titleScope:{mode:'source_default',rdjb:[]},unfinished:[],error:null,pages:[{source:'queryList',rdjb:null,page:1,status:'success',fetchedCount:0,declaredTotal:0}]} as never})
    f.row(q.id,1,{enterpriseId:null,usccRaw:'unrelated'})
    assertUnavailable428(f,[q.id])
  }finally{f.sqlite.close()}
})
it('split428_no_events_does_not_bypass_owner_protection',()=>{
  const f=fixture428Input();try{
    f.db.insert(schema.recordCorrespondence).values({edgeKey:'no-events-protected',type:'event_process',role:'supports_award',enterpriseId:f.e.id,titleCode:'specialized_sme',status:'rejected',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:'2026-01-01T00:00:00Z'}).run()
    f.sqlite.pragma('query_only=ON');const before=f.sqlite.prepare('select total_changes() n').get()
    expect(()=>f.sqlite.transaction(()=>readPlatformComparisonProcesses(f.sqlite,{...f.request([]),eventIds:[]}))()).toThrowError(new Error('platform_comparison_scope_unavailable'))
    expect(f.sqlite.prepare('select total_changes() n').get()).toEqual(before)
  }finally{f.sqlite.close()}
})


// #428 independent real SQLite admission boundaries; limits frozen before runs.
function budgetRead428(f:ReturnType<typeof fixture428Input>, ids:number[], over:boolean) {
  f.sqlite.pragma('query_only=ON')
  const changes=f.sqlite.prepare('select total_changes() n').get()
  try {
    if(over) { expect(()=>f.batch(ids)).toThrowError(new Error('input_resource_limit')); return null }
    const batch=f.batch(ids)
    expect(batch.kind).toBe('present')
    expect(batch.entries).toHaveLength(1)
    expect(batch.admission.uniqueScalarBytes).toBeLessThanOrEqual(1048576)
    expect(batch.admission.expandedCharge).toBeLessThanOrEqual(16777216)
    return batch
  } finally {
    expect(f.sqlite.prepare('select total_changes() n').get()).toEqual(changes)
    expect(f.sqlite.pragma('query_only',{simple:true})).toBe(1)
  }
}
function budgetDecision428(f:ReturnType<typeof fixture428Input>, relationId:number, id:number, proofIds:number[]=[]) {
  f.db.insert(schema.recordCorrespondence).values({edgeKey:`budget428-${id}`,type:'event_process',role:'supports_award',eventId:f.event.id,relationId,enterpriseId:f.e.id,titleCode:'specialized_sme',status:'candidate',revision:1,targetIdentity:{},provenance:{comparisonProofIds:proofIds},sourceFingerprint:'synthetic',ruleId:'manual',ruleVersion:'1',createdAt:'2026-01-01T00:00:00Z'}).run()
}
it.each([64,65])('budget428_titles_%i',count=>{
  const f=fixture428Input();try {
    const q=f.query();f.row(q.id)
    const other=f.query({rdjb:'1',titleCode:'innovative_sme'})
    for(let i=1;i<count;i++)f.row(other.id,i)
    expect(f.sqlite.prepare('select count(*) n from platform_relation').get()).toEqual({n:count})
    const out=budgetRead428(f,[q.id,other.id],count===65)
    if(out) {
      expect(out.entries[0]!.read.sourceRefs.titleScopeRefs).toHaveLength(64)
      expect(out.entries[0]!.read.sourceRefs.observations).toHaveLength(1)
    }
  }finally{f.sqlite.close()}
})
it.each([128,129])('budget428_history_%i',count=>{
  const f=fixture428Input();try {
    const q=f.query();const admitted=f.row(q.id)
    const record=f.db.insert(schema.platformBusinessRecord).values({interface:'business_list',platformKey:'B1',identityRuleVersion:'fixture'}).returning().get()
    const rows=[admitted.id]
    for(let i=2;i<=count;i++)rows.push(f.row(q.id,i,{enterpriseId:null,usccRaw:'unrelated'}).id)
    for(const relationId of rows)f.db.insert(schema.platformBusinessObservation).values({relationId,recordId:record.id,versionId:null,identityState:'resolved',contentState:'unverifiable',keySource:'relation_key',projectionRuleVersion:'fixture',inputFingerprint:'fixture'}).run()
    expect(f.sqlite.prepare('select count(*) n from platform_business_observation').get()).toEqual({n:count})
    const out=budgetRead428(f,[q.id],count===129)
    if(out) {
      expect(out.history.get(record.id)).toEqual(rows)
      expect(out.entries[0]!.read.sourceRefs.observations).toHaveLength(1)
    }
  }finally{f.sqlite.close()}
})
it.each([128,129])('budget428_decisions_%i',count=>{
  const f=fixture428Input();try {
    const q=f.query();const row=f.row(q.id)
    for(let i=1;i<=count;i++)budgetDecision428(f,row.id,i)
    expect(f.sqlite.prepare('select count(*) n from record_correspondence').get()).toEqual({n:count})
    const out=budgetRead428(f,[q.id],count===129)
    if(out)expect(out.entries[0]!.input.groups.flatMap(g=>g.observationRefs).flatMap(o=>o.existingCorrespondenceIds)).toHaveLength(128)
  }finally{f.sqlite.close()}
})
it.each([160,161])('budget428_evidence_%i',count=>{
  const f=fixture428Input();try {
    const q=f.query();f.row(q.id)
    for(let i=1;i<=count;i++)f.db.insert(schema.recordEvidence).values({recordEventId:f.event.id,sourceFile:'x',listNo:i}).run()
    expect(f.sqlite.prepare('select count(*) n from record_evidence').get()).toEqual({n:count})
    const out=budgetRead428(f,[q.id],count===161)
    if(out)expect(out.entries[0]!.read.sourceRefs.evidence).toHaveLength(160)
  }finally{f.sqlite.close()}
})
it.each([100,101])('budget428_proof_elements_%i',count=>{
  const f=fixture428Input();try {
    const q=f.query();const row=f.row(q.id)
    const ids=Array.from({length:count},(_,i)=>i+1);budgetDecision428(f,row.id,1,ids)
    expect(f.sqlite.prepare("select json_array_length(provenance,'$.comparisonProofIds') n from record_correspondence").get()).toEqual({n:count})
    const out=budgetRead428(f,[q.id],count===101)
    if(out)expect(out.entries[0]!.read.sourceRefs.observations).toHaveLength(1)
  }finally{f.sqlite.close()}
})
it('budget428_raw7_4096',()=>{
  const f=fixture428Input();try {
    const q=f.query();f.row(q.id,1,{rawFields:{cszt:'x'.repeat(4062)}})
    // Six nulls24 + six commas6 + brackets2 + quotes2 +4062 ASCII =4096.
    expect(Buffer.byteLength(JSON.stringify([null,null,null,null,null,null,'x'.repeat(4062)]))).toBe(4096)
    const out=budgetRead428(f,[q.id],false)
    expect(out!.entries[0]!.read.sourceRefs.observations).toHaveLength(1)
  }finally{f.sqlite.close()}
})


// Frozen independent literal fee fixtures; arithmetic derivation is Git-external.
it.each([65536,65537])('fee428_source_U_%i',limit=>{
  const f=fixture428Input();try {
    const q=f.query();f.row(q.id)
    const count=limit===65536?1:4, width=limit===65536?10589:2621
    for(let i=1;i<=count;i++)f.db.insert(schema.recordEvidence).values({recordEventId:f.event.id,sourceFile:'x'.repeat(width),listNo:i,page:limit===65536?null:1}).run()
    expect(Buffer.byteLength('x'.repeat(width))).toBe(width)
    const out=budgetRead428(f,[q.id],limit===65537)
    if(out) {
      expect(out.admission.sourceUpperBytes).toEqual([65536])
      expect(out.admission.actualSourceBytes[0]).toBeLessThan(65536)
      expect(out.admission.uniqueScalarBytes).toBe(67487)
      expect(out.admission.expandedCharge).toBe(1402569)
    }
  }finally{f.sqlite.close()}
})
it.each([16777216,16777217])('fee428_policy_W_%i',limit=>{
  const f=fixture428Input();try {
    const exact=limit===16777216,q=f.query();f.row(q.id,1,{nameRaw:exact?'':null})
    f.sqlite.prepare('update enterprise set name_norm=? where id=?').run('x'.repeat(exact?80961:80976),f.e.id)
    if(!exact)f.sqlite.prepare('update record_event set decided_year=2024 where id=?').run(f.event.id)
    for(let i=1;i<=(exact?2:1);i++)f.db.insert(schema.recordEvidence).values({recordEventId:f.event.id,sourceFile:'x'.repeat(exact?3:2),listNo:i}).run()
    const out=budgetRead428(f,[q.id],!exact)
    if(out) {
      expect(out.admission.expandedCharge).toBe(16777216)
      expect(out.admission.uniqueScalarBytes).toBe(489897)
      expect(out.admission.sourceUpperBytes).toEqual([2211])
    }
  }finally{f.sqlite.close()}
})
it.each([1048576,1048578])('fee428_absent_A_%i',limit=>{
  const f=fixture428Input();try {
    const exact=limit===1048576
    f.sqlite.prepare('update enterprise set name_norm=? where id=?').run('x'.repeat(exact?174620:174625),f.e.id)
    if(exact)f.sqlite.prepare('update record_event set decided_year=2024 where id=?').run(f.event.id)
    f.sqlite.pragma('query_only=ON');const changes=f.sqlite.prepare('select total_changes() n').get()
    if(exact) {
      const out=f.batch([])
      expect(out.kind).toBe('absent');expect(out.entries).toEqual([])
      expect(out.admission.uniqueScalarBytes).toBe(1048576)
      expect(out.admission.expandedCharge).toBeNull()
      expect(out.admission.sourceUpperBytes).toEqual([])
    } else expect(()=>f.batch([])).toThrowError(new Error('input_resource_limit'))
    expect(f.sqlite.prepare('select total_changes() n').get()).toEqual(changes)
    expect(f.sqlite.pragma('query_only',{simple:true})).toBe(1)
  }finally{f.sqlite.close()}
})

it.each([65532,65540])('fee428_query_U_nearest_%i',fee=>{
  const f=fixture428Input();try {
    const exactBelow=fee===65532,count=exactBelow?3:1
    const metadata={source:'businessList',status:'success',effectiveConditions:null,titleScope:{mode:'selected',rdjb:['2']},
      pages:Array.from({length:count},(_,i)=>({source:'businessList',rdjb:'2',page:i+1,status:'success',fetchedCount:i===0?1:0,declaredTotal:1,error:null})),
      completeness:'complete',fullRange:true,unfinished:[],error:'x'.repeat(exactBelow?1909:2138),limits:null}
    const bytes=Buffer.byteLength(JSON.stringify({...metadata,fullRange:1}))
    expect(bytes).toBe(exactBelow?2456:2459)
    // Independently tabulated seven scalar fields cost567; fixed policy charge.
    expect(4096+4*567+4*(32+6*bytes)+32*count).toBe(fee)
    const q=f.query({collectionEvidence:metadata as never});f.row(q.id)
    const out=budgetRead428(f,[q.id],!exactBelow)
    if(out)expect(out.entries[0]!.input.coverage).toEqual([{queryId:q.id,interface:'business_list',queriedAt:'2026-05-31T00:00:00Z',status:'success',completeness:'complete',fullRange:true}])
  }finally{f.sqlite.close()}
})
