import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect,it } from 'vitest'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { targetSchema } from '../lib/platform/target-schema'
import { writeProcessTarget,type ProcessTargetInput } from '../lib/platform/process-target-writer'
import { verifyFingerprint,emptyFingerprintTarget } from '../lib/platform/fingerprint-verifier'
import { processStoredInstalled } from '../lib/platform/process-stored-catalog'
import { assertExpandRuntime } from '../db/schema-phase'
import { writeCollectionTarget,type NewCollectionTargetCommand } from '../lib/platform/collection-target-command'
import { projectionManifest } from '../upgrade/projections'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'

async function ready(raw?:string,uncapturedCommand=false){
 const f=await witnessReaderFixture(source=>{
  source.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','Q','2','t','success','c');
  INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(1,1,1,'{"id":"H","rdjb":"2","rdjb":"3","cszt":"pending"}','c');
  UPDATE platform_relation SET title_raw='X',status=' pending ';`)
  if(raw!==undefined){source.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=1').run(raw);source.exec("UPDATE platform_relation SET title_raw='X'")}
 });f.close()
 if(uncapturedCommand){
  const old=new Database(f.target);old.pragma('foreign_keys=ON')
  const c=command(),q=JSON.parse(c.queryText);q.relations[0].nameRaw=' Old ';c.queryText=JSON.stringify(q);c.assignments[0]!.nameRaw=' Old '
  try{writeCollectionTarget(drizzle(old,{schema:targetSchema}),c)}finally{old.close()}
 }
 const source=join(f.root,'process-source.sqlite');copyFileSync(f.target,source)
 finalizeProcessStored({source,target:f.target,runId:'process',predecessorRunId:'witness',legacySource:f.legacySource})
 const t=new Database(f.target);t.pragma('foreign_keys=ON');return {f,t,db:drizzle(t,{schema:targetSchema})}
}
function input():ProcessTargetInput{return {collectionId:1,position:{sequenceNo:2,positionState:'unknown'},row:{sequenceNo:2,relationKey:' K ',nameRaw:' Old ',usccRaw:' U ',status:' pending ',declareKind:'申请',batch:' B ',appliedAt:' D ',awardBatchLabel:' Award ',province:' P ',year:2024,rawFields:{id:'K',rdjb:' 2 ',cszt:'pending'}},assignment:{nameRaw:'Old',usccRaw:'U',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'A2'},basis:'explicit'}}}
it('71610 direct process writer captures eight literal old cells without replacing original canonical input',async()=>{
 const {t,db}=await ready()
 try{
  const v=input(),r=writeProcessTarget(db,v)
  expect(t.prepare('SELECT exact_status,exact_declare_kind,exact_applied_at,exact_year,exact_title_raw,exact_batch,exact_award_batch_label,exact_province,sql_fact_title FROM platform_business_projection WHERE observation_id=?').get(r.observationId)).toEqual({exact_status:'pending',exact_declare_kind:'apply',exact_applied_at:'D',exact_year:2024,exact_title_raw:'2',exact_batch:'B',exact_award_batch_label:'Award',exact_province:'P',sql_fact_title:'2'})
  const literal='{"assignment":{"actor":{"id":"A2","type":"agent"},"basis":"explicit","matchBasis":"none","nameRaw":"Old","origin":"command","usccRaw":"U","verificationStatus":"pending"},"collectionId":1,"position":{"positionState":"unknown","sequenceNo":2},"row":{"appliedAt":" D ","awardBatchLabel":" Award ","batch":" B ","declareKind":"申请","nameRaw":" Old ","province":" P ","rawFields":{"cszt":"pending","id":"K","rdjb":" 2 "},"relationKey":" K ","sequenceNo":2,"status":" pending ","usccRaw":" U ","year":2024}}'
  expect(t.prepare('SELECT cast(a.bytes AS TEXT) bytes,o.input_fingerprint hash,o.source_relation_key key FROM platform_business_observation o JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE o.id=?').get(r.observationId)).toEqual({bytes:literal,hash:createHash('sha256').update(literal).digest('hex'),key:'K'})
  expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow()
  expect(writeProcessTarget(db,v).reused).toBe(true)
 }finally{t.close()}
})

function command():NewCollectionTargetCommand{return {queryText:JSON.stringify({interface:'business_list',queryKey:'new',queriedAt:'time',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,status:' pending ',declareKind:'申请',batch:' B ',awardBatchLabel:' Award ',province:' P ',appliedAt:' D ',rawFields:{id:'N',rdjb:' 2 ',cszt:'pending',year:'2e3'}}]}),evidenceText:null,createdAt:'creation',assignments:[{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'A2'},basis:'explicit'}]}}
function reference(c:NewCollectionTargetCommand){const q=JSON.parse(c.queryText);q.reuseExisting=true;delete q.rawResponse;delete q.status;delete q.collectionEvidence;q.relations=[{sequenceNo:1}];return {...c,queryText:JSON.stringify(q),evidenceText:null,assignments:[]}}
it('71610 full process command ordinary and reference certify materialization without replay writes',async()=>{
 const {t,db}=await ready()
 try{
  const c=command(),r=writeCollectionTarget(db,c),id=r.observations[0]!.observationId
  expect(t.prepare('SELECT exact_year,business_year,exact_batch,exact_award_batch_label,exact_province,exact_applied_at,sql_fact_title FROM platform_business_projection WHERE observation_id=?').get(id)).toEqual({exact_year:2000,business_year:null,exact_batch:'B',exact_award_batch_label:'Award',exact_province:'P',exact_applied_at:'D',sql_fact_title:'2'})
  const before=projectionManifest(t),catalog=schemaHash(t)
  expect(writeCollectionTarget(db,c).reused).toBe(true);expect(writeCollectionTarget(db,reference(c)).reused).toBe(true)
  expect(projectionManifest(t)).toBe(before);expect(schemaHash(t)).toBe(catalog)
 }finally{t.close()}
})
it('71610 historical ordinary bootstrap and reference preserve padded original cells and SQL first-key title',async()=>{
 const {t,db}=await ready()
 try{
  const ref={queryText:JSON.stringify({interface:'business_list',queryKey:'Q',rdjb:'2',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1}]}),evidenceText:null,createdAt:'unused',assignments:[]}
  const before=projectionManifest(t)
  expect(writeCollectionTarget(db,ref).reused).toBe(true);expect(projectionManifest(t)).toBe(before)
  const ordinary={...ref,queryText:JSON.stringify({interface:'business_list',queryKey:'Q',rdjb:'2',queriedAt:'t',status:'success',relations:[{sequenceNo:1,status:'pending',rawFields:{id:'H',rdjb:'3',cszt:'pending'}}]})}
  expect(writeCollectionTarget(db,ordinary).reused).toBe(true)
  expect(t.prepare('SELECT exact_status,exact_title_raw,sql_fact_title,source_title_text FROM platform_business_projection WHERE observation_id=1').get()).toEqual({exact_status:' pending ',exact_title_raw:'X',sql_fact_title:'2',source_title_text:'3'})
  expect(()=>verifyFingerprint(t,{observationId:1,collectionId:1,relationAlias:1})).not.toThrow()
 }finally{t.close()}
})

it('71610 BOM original SQL NULL remains distinct from canonical parsing during ordinary and reference authentication',async()=>{
 const {t,db}=await ready('\ufeff{"id":"H","rdjb":"2","cszt":"pending"}')
 try{
  expect(t.prepare('SELECT sql_fact_title FROM platform_business_projection WHERE observation_id=1').get()).toEqual({sql_fact_title:null})
  const ref={queryText:JSON.stringify({interface:'business_list',queryKey:'Q',rdjb:'2',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1}]}),evidenceText:null,createdAt:'unused',assignments:[]}
  expect(writeCollectionTarget(db,ref).reused).toBe(true)
  expect(writeCollectionTarget(db,{...ref,queryText:JSON.stringify({interface:'business_list',queryKey:'Q',rdjb:'2',queriedAt:'t',relations:[{sequenceNo:1,status:'pending',rawFields:{id:'H',rdjb:'2',cszt:'pending'}}]})}).reused).toBe(true)
  expect(t.prepare('SELECT sql_fact_title,exact_title_raw FROM platform_business_projection WHERE observation_id=1').get()).toEqual({sql_fact_title:null,exact_title_raw:'X'})
 }finally{t.close()}
})

function corrupt(t:Database.Database,tables:string[],sql:string,params:(string|number|null)[]=[]){
 const triggers=t.prepare("SELECT name,sql,tbl_name FROM sqlite_schema WHERE type='trigger'").all() as {name:string,sql:string,tbl_name:string}[]
 const owned=triggers.filter(r=>tables.includes(r.tbl_name))
 for(const r of owned)t.exec(`DROP TRIGGER "${r.name}"`)
 t.exec('PRAGMA ignore_check_constraints=ON')
 try{t.prepare(sql).run(...params)}finally{t.exec('PRAGMA ignore_check_constraints=OFF');for(const r of owned)t.exec(r.sql)}
}
it('71610 command ordinary reference and direct reuse reject every exact cell metadata and source drift without repair',async()=>{
 const {t,db}=await ready()
 try{
  const c=command(),r=writeCollectionTarget(db,c),id=r.observations[0]!.observationId
  const v=input(),d=writeProcessTarget(db,v)
  for(const field of ['exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','exact_batch','exact_award_batch_label','exact_province','sql_fact_title','exact_stored_rule','sql_fact_title_rule','exact_stored_origin','parsed_status','revision1','alias','rule','missing']){
   t.exec('BEGIN')
   const tables=field==='revision1'?['platform_observation_assignment']:field==='alias'?['platform_legacy_relation_alias']:field==='rule'?['platform_business_observation']:['platform_business_projection']
   for(const n of [id,d.observationId]){
    if(field==='revision1')corrupt(t,tables,"UPDATE platform_observation_assignment SET name_raw='wrong' WHERE observation_id=? AND revision=1",[n])
    else if(field==='alias')corrupt(t,tables,'DELETE FROM platform_legacy_relation_alias WHERE observation_id=?',[n])
    else if(field==='rule')corrupt(t,tables,"UPDATE platform_business_observation SET projection_rule_version='wrong' WHERE id=?",[n])
    else if(field==='missing')corrupt(t,tables,'DELETE FROM platform_business_projection WHERE observation_id=?',[n])
    else corrupt(t,tables,`UPDATE platform_business_projection SET ${field}=? WHERE observation_id=?`,[field==='exact_year'?2025:'wrong',n])
   }
   const before=projectionManifest(t)
   expect(()=>writeCollectionTarget(db,c),field).toThrow();expect(()=>writeCollectionTarget(db,reference(c)),field).toThrow();expect(()=>writeProcessTarget(db,v),field).toThrow()
   expect(projectionManifest(t),field).toBe(before);t.exec('ROLLBACK')
  }
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})
it('71610 historical reference rejects original exact drift and uncaptured states instead of supplementing from archives',async()=>{
 const {t,db}=await ready()
 try{
  const ref={queryText:JSON.stringify({interface:'business_list',queryKey:'Q',rdjb:'2',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1}]}),evidenceText:null,createdAt:'unused',assignments:[]}
  for(const field of ['exact_status','exact_declare_kind','exact_year','exact_batch','exact_applied_at','exact_award_batch_label','exact_province','exact_title_raw','sql_fact_title','exact_stored_rule','sql_fact_title_rule','exact_stored_origin','exact_stored_state','sql_fact_title_state','revision1']){
   t.exec('BEGIN')
   if(field==='revision1')corrupt(t,['platform_observation_assignment'],"UPDATE platform_observation_assignment SET name_raw='wrong' WHERE observation_id=1 AND revision=1")
   else corrupt(t,['platform_business_projection'],`UPDATE platform_business_projection SET ${field}=? WHERE observation_id=1`,[field==='exact_year'?2025:field.endsWith('_state')?'uncaptured':'wrong'])
   const before=projectionManifest(t);expect(()=>writeCollectionTarget(db,ref),field).toThrow();expect(projectionManifest(t)).toBe(before);t.exec('ROLLBACK')
  }
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})
it('71610 current revision2 correction stays visible while original input certification remains pinned to revision1',async()=>{
 const {t,db}=await ready()
 try{
  const v=input(),r=writeProcessTarget(db,v)
  t.prepare("INSERT INTO platform_observation_assignment(observation_id,revision,name_raw,uscc_raw,match_basis,verification_status,origin,actor,basis) VALUES(?,2,'New','NEW','none','pending','command','{\"type\":\"agent\",\"id\":\"A2\"}','correction')").run(r.observationId)
  expect(t.prepare('SELECT name_raw FROM platform_observation_assignment WHERE observation_id=? ORDER BY revision DESC LIMIT 1').get(r.observationId)).toEqual({name_raw:'New'})
  expect(writeProcessTarget(db,v).reused).toBe(true);expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow()
 }finally{t.close()}
})
it('71610 process savepoint rolls back every injected owner failure caught by an outer caller',async()=>{
 const {t,db}=await ready()
 try{
  for(const table of ['platform_business_record','platform_business_record_version','platform_version_archive_ref','platform_observation_assignment','platform_observation_archive_ref','platform_business_projection','platform_legacy_relation_alias','platform_observation_fingerprint_basis']){
   t.exec(`CREATE TEMP TRIGGER inject BEFORE INSERT ON main.${table} BEGIN SELECT RAISE(ABORT,'injected'); END`)
   const before=projectionManifest(t)
   db.transaction(tx=>{expect(()=>writeProcessTarget(tx,input()),table).toThrow('injected')})
   expect(projectionManifest(t)).toBe(before);expect(t.pragma('foreign_key_check')).toEqual([]);t.exec('DROP TRIGGER temp.inject')
  }
 }finally{t.close()}
})

it('71610 FK OFF unsafe positions exhausted IDs and full-command failure leave no partial owners',async()=>{
 const {t,db}=await ready()
 try{
  t.pragma('foreign_keys=OFF');let before=projectionManifest(t)
  expect(()=>writeProcessTarget(db,input())).toThrow(/foreign_keys/);expect(()=>writeCollectionTarget(db,command())).toThrow(/foreign_keys/);expect(projectionManifest(t)).toBe(before)
  t.pragma('foreign_keys=ON')
  expect(()=>writeProcessTarget(db,{...input(),position:{sequenceNo:2,pageId:Number.MAX_SAFE_INTEGER+1,positionState:'unknown'}})).toThrow(/Invalid target identity/)
  expect(()=>writeProcessTarget(db,{...input(),assignment:{...input().assignment,nameRaw:' Old '}})).toThrow(/revision1/)
  expect(()=>writeProcessTarget(db,{...input(),row:{...input().row,year:2024.5}})).toThrow(/Unrepresentable legacy process year/)
  expect(projectionManifest(t)).toBe(before)
  for(const sql of ["DELETE FROM sqlite_sequence WHERE name='platform_business_observation';INSERT INTO sqlite_sequence(name,seq) VALUES('platform_business_observation',9007199254740991)","UPDATE platform_legacy_alias_sequence SET high_water=9007199254740991 WHERE namespace='relation'"]){
   t.exec('BEGIN');t.exec(sql);before=projectionManifest(t);expect(()=>writeProcessTarget(db,input())).toThrow();expect(projectionManifest(t)).toBe(before);t.exec('ROLLBACK')
  }
  t.exec("DELETE FROM sqlite_sequence WHERE name='platform_business_observation';INSERT INTO sqlite_sequence(name,seq) VALUES('platform_business_observation',9007199254740990)")
  const last=writeProcessTarget(db,input());expect(last.observationId).toBe(Number.MAX_SAFE_INTEGER);expect(t.pragma('foreign_key_check')).toEqual([])
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
 const other=await ready()
 try{
  other.t.exec("CREATE TEMP TRIGGER inject BEFORE INSERT ON main.platform_business_projection BEGIN SELECT RAISE(ABORT,'full command injected'); END")
  const before=projectionManifest(other.t)
  other.db.transaction(tx=>{expect(()=>writeCollectionTarget(tx,command())).toThrow('full command injected')})
  expect(projectionManifest(other.t)).toBe(before)
 }finally{other.t.close()}
})
it('71610 paired direct writer defers missing projection or capture branch until outer COMMIT and caller rollback',async()=>{
 const {t,db}=await ready()
 try{
  const before=projectionManifest(t)
  for(const field of ['missing','exact_stored_state','sql_fact_title_state']){
   t.exec('BEGIN');const r=writeProcessTarget(db,input());t.exec('SAVEPOINT after_writer')
   if(field==='missing')corrupt(t,['platform_business_projection'],'DELETE FROM platform_business_projection WHERE observation_id=?',[r.observationId])
   else corrupt(t,['platform_business_projection'],`UPDATE platform_business_projection SET ${field}='uncaptured' WHERE observation_id=?`,[r.observationId])
   t.exec('RELEASE after_writer');expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);expect(t.inTransaction).toBe(true);t.exec('ROLLBACK');expect(projectionManifest(t)).toBe(before)
  }
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})
it('71610 apply and recognized full-command behavior remains certified with original source-specific owners',async()=>{
 const {t,db}=await ready()
 try{
  for(const source of ['apply_list','recognized_list']){
   const c=command(),q=JSON.parse(c.queryText);q.interface=source;q.queryKey=source;q.relations=[{sequenceNo:1,rawFields:{id:source,rdjb:'2'}}];c.queryText=JSON.stringify(q)
   if(source==='recognized_list'){
    const evidence:PlatformLiveQueryResult={source:'queryBusList',status:'success',effectiveConditions:{name:'Example',combination:'and'},titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-11-11T00:00:00Z',completedAt:'2026-11-11T00:01:00Z',rows:[{id:'R',qymc:'Example',rdjb:'2'}],pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
    c.queryText=JSON.stringify(platformResultToImport(evidence));c.evidenceText=JSON.stringify(evidence)
   }
   const r=writeCollectionTarget(db,c),before=projectionManifest(t)
   expect(writeCollectionTarget(db,c).reused).toBe(true);expect(writeCollectionTarget(db,reference(c)).reused).toBe(true)
   expect(()=>verifyFingerprint(t,{observationId:r.observations[0]!.observationId,collectionId:r.collectionId,relationAlias:r.observations[0]!.relationAlias})).not.toThrow()
   expect(projectionManifest(t)).toBe(before)
  }
 }finally{t.close()}
})

it('71610 omission NULL blank and position own keys retain distinct literal canonical envelopes',async()=>{
 const {t,db}=await ready()
 try{
  const rows=[{sequenceNo:2},{sequenceNo:3,status:null,rawFields:null},{sequenceNo:4,status:' ',rawFields:{rdjb:' '}}]
  const rowLiterals=['{"sequenceNo":2}','{"rawFields":null,"sequenceNo":3,"status":null}','{"rawFields":{"rdjb":" "},"sequenceNo":4,"status":" "}']
  const positionLiterals=['{"positionState":"unknown","sequenceNo":2}','{"pageId":null,"pageRowNo":null,"positionState":"unknown","sequenceNo":3}','{"positionState":"unknown","sequenceNo":4}']
  for(const [i,row] of rows.entries()){
   const v:ProcessTargetInput={collectionId:1,row,position:{sequenceNo:row.sequenceNo,positionState:'unknown',...(i===1?{pageId:null,pageRowNo:null}:{})},assignment:{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'A2'},basis:'explicit'}}
   const r=writeProcessTarget(db,v)
   const literal='{"assignment":{"actor":{"id":"A2","type":"agent"},"basis":"explicit","matchBasis":"none","origin":"command","verificationStatus":"pending"},"collectionId":1,"position":'+positionLiterals[i]+',"row":'+rowLiterals[i]+'}'
   expect(t.prepare('SELECT cast(a.bytes AS TEXT) bytes,o.input_fingerprint hash FROM platform_business_observation o JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE o.id=?').get(r.observationId)).toEqual({bytes:literal,hash:createHash('sha256').update(literal).digest('hex')})
   expect(t.prepare('SELECT exact_status,exact_declare_kind,exact_applied_at,exact_year,exact_title_raw,exact_batch,exact_award_batch_label,exact_province,sql_fact_title FROM platform_business_projection WHERE observation_id=?').get(r.observationId)).toEqual({exact_status:null,exact_declare_kind:null,exact_applied_at:null,exact_year:null,exact_title_raw:null,exact_batch:null,exact_award_batch_label:null,exact_province:null,sql_fact_title:null})
   expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow()
  }
 }finally{t.close()}
})
it('71610 identical raw versions do not merge different stored inputs or replace original capture on reuse conflict',async()=>{
 const {t,db}=await ready()
 try{
  const v=input(),a=writeProcessTarget(db,v),b=writeProcessTarget(db,{...v,position:{...v.position,sequenceNo:3},row:{...v.row,sequenceNo:3,status:'rejected'}})
  expect(a.versionId).toBe(b.versionId)
  expect(t.prepare('SELECT exact_status FROM platform_business_projection WHERE observation_id IN(?,?) ORDER BY observation_id').all(a.observationId,b.observationId)).toEqual([{exact_status:'pending'},{exact_status:null}])
  const before=projectionManifest(t);expect(()=>writeProcessTarget(db,{...v,row:{...v.row,status:'rejected'}})).toThrow(/conflict/);expect(projectionManifest(t)).toBe(before)
 }finally{t.close()}
})

it('71610 raw archive input basis and archive metadata drift are rejected independently without source repair',async()=>{
 const {t,db}=await ready()
 try{
  const c=command(),r=writeCollectionTarget(db,c),id=r.observations[0]!.observationId
  for(const [target,field] of [['raw','bytes'],['raw','byte_length'],['basis','bytes']] as const){
   t.exec('BEGIN')
   const archive=(target==='raw'?t.prepare("SELECT archive_id id FROM platform_observation_archive_ref WHERE owner_id=? AND field='rawFields'"):t.prepare('SELECT input_archive_id id FROM platform_observation_fingerprint_basis WHERE observation_id=?')).get(id) as {id:number}
   corrupt(t,['platform_archive_value'],`UPDATE platform_archive_value SET ${field}=${field==='bytes'?"CAST('{}' AS BLOB)":'byte_length+1'} WHERE id=?`,[archive.id])
   const before=projectionManifest(t)
   expect(()=>verifyFingerprint(t,{observationId:id,collectionId:r.collectionId,relationAlias:r.observations[0]!.relationAlias})).toThrow()
   expect(()=>writeCollectionTarget(db,c)).toThrow();expect(()=>writeCollectionTarget(db,reference(c))).toThrow();expect(projectionManifest(t)).toBe(before);t.exec('ROLLBACK')
  }
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})
it('71610 legitimate historical A1 uncaptured command stays refused by ordinary and reference without supplementation',async()=>{
 const {t,db}=await ready(undefined,true)
 try{
  const row=t.prepare("SELECT p.observation_id id,p.exact_stored_state state,p.exact_stored_reason reason FROM platform_business_projection p JOIN platform_business_observation o ON o.id=p.observation_id JOIN platform_collection c ON c.id=o.collection_id WHERE c.query_key='new'").get() as {id:number,state:string,reason:string}
  expect(row).toMatchObject({state:'uncaptured',reason:'command-materialization-revision1-or-key-incompatible'})
  const c=command(),q=JSON.parse(c.queryText);q.relations[0].nameRaw=' Old ';c.queryText=JSON.stringify(q);c.assignments[0]!.nameRaw=' Old '
  const before=projectionManifest(t)
  expect(()=>writeCollectionTarget(db,c)).toThrow();expect(()=>writeCollectionTarget(db,reference(c))).toThrow();expect(projectionManifest(t)).toBe(before)
 }finally{t.close()}
})

it('71610 original BOM source text bytes survive full-command ordinary and reference source certification',async()=>{
 const {t,db}=await ready()
 try{
  const c=command(),q=JSON.parse(c.queryText);q.relations[0].sourceText='\ufeffOriginal\u0000';c.queryText=JSON.stringify(q)
  const r=writeCollectionTarget(db,c),id=r.observations[0]!.observationId
  expect(t.prepare("SELECT hex(a.bytes) hex FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field='sourceText'").get(id)).toEqual({hex:'EFBBBF4F726967696E616C00'})
  expect(writeCollectionTarget(db,c).reused).toBe(true);expect(writeCollectionTarget(db,reference(c)).reused).toBe(true)
 }finally{t.close()}
})

it.each([' K ', '   '])('71610 full command preserves original key bytes and replays materialized key: %j', async key => {
 const {t,db}=await ready()
 try {
  const c=command(),q=JSON.parse(c.queryText);q.relations[0].relationKey=key;c.queryText=JSON.stringify(q)
  const written=writeCollectionTarget(db,c),id=written.observations[0]!.observationId
  expect(t.prepare('SELECT source_relation_key k FROM platform_business_observation WHERE id=?').get(id)).toEqual({k:key.trim()||null})
  const before=projectionManifest(t)
  expect(writeCollectionTarget(db,c).reused).toBe(true)
  expect(writeCollectionTarget(db,reference(c)).reused).toBe(true)
  expect(projectionManifest(t)).toBe(before)
  t.exec('BEGIN')
  t.prepare('UPDATE platform_business_observation SET source_relation_key=? WHERE id=?').run('forged',id)
  const drift=projectionManifest(t)
  expect(()=>writeCollectionTarget(db,c)).toThrow()
  expect(()=>writeCollectionTarget(db,reference(c))).toThrow()
  expect(projectionManifest(t)).toBe(drift)
  t.exec('ROLLBACK')
 } finally {if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})
