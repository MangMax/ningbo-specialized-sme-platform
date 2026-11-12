import Database from 'better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateFixture } from './helpers/candidate-scope-target'
import { finalizeCandidateScopes } from '../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../upgrade/recognized-stored'
import { projectionManifest } from '../upgrade/projections'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import * as legacySchema from '../db/schema'
import { verifyRecognizedStored } from '../lib/platform/recognized-stored'
async function ready() {
 const f=await candidateFixture(old=>{
 old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'recognized_list','Q','1,2,3','t','success','c');
 INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(1,1,1,'{"id":"shared","rdjb":"1"}','c'),(2,1,2,'{"id":"shared","rdjb":"1"}','c'),(3,1,3,'{"rdjb":false}','c'),(4,1,4,NULL,'c'),(5,1,5,'{"rdjb":2}','c');
 UPDATE platform_relation SET title_raw=CASE id WHEN 1 THEN '2' WHEN 2 THEN '3' WHEN 3 THEN '  ' WHEN 4 THEN NULL ELSE X'3200ff' END;`)
 const db=drizzle(old,{schema:legacySchema});ensurePlatformObservation(db,1);ensurePlatformObservation(db,2)
 })
 finalizeCandidateScopes(f)
 const source=join(f.root,'71609.sqlite');copyFileSync(f.target,source)
 return { ...f,source,runId:'recognized-stored',predecessorRunId:'candidate' }
}
it('captures exact legacy title NULL whitespace and BLOB cells independently of source title on actual SQLite migration and replay',async()=>{
 const f=await ready();const result=finalizeRecognizedStored(f)
 expect(result).toMatchObject({state:'complete',captured:5,uncaptured:0})
 const t=new Database(f.target)
 try {
 expect(t.prepare('SELECT typeof(exact_title_raw) kind,hex(exact_title_raw) hex,exact_title_state state,title_raw,source_title_kind FROM platform_recognized_projection WHERE observation_id IS NOT NULL ORDER BY observation_id').all()).toEqual([
 {kind:'text',hex:'32',state:'captured',title_raw:'1',source_title_kind:'text'},
 {kind:'text',hex:'33',state:'captured',title_raw:'1',source_title_kind:'text'},
 {kind:'text',hex:'2020',state:'captured',title_raw:null,source_title_kind:'boolean'},
 {kind:'null',hex:'',state:'captured',title_raw:null,source_title_kind:'absent'},
 {kind:'blob',hex:'3200FF',state:'captured',title_raw:null,source_title_kind:'number'},
 ])
 for(let id=1;id<=5;id++)verifyRecognizedStored(t,id)
 }finally{t.close()}
 expect(finalizeRecognizedStored(f)).toEqual(result)
})


import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema } from '../lib/platform/target-schema'
import { writeRecognizedTarget, type RecognizedTargetInput } from '../lib/platform/recognized-target-writer'
import { verifyFingerprint } from '../lib/platform/fingerprint-verifier'
function command(sequenceNo:number,rdjb:unknown):RecognizedTargetInput {
 return {collectionId:1,position:{sequenceNo,positionState:'unknown'},row:{sequenceNo,relationKey:'shared-command',rawFields:{id:'shared-command',rdjb}},assignment:{enterpriseId:null,matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'732'},basis:'explicit',nameRaw:null,usccRaw:null}}
}
it('materializes command titles by independent old SQL string-only grammar and certifies exact replay without rewriting bytes',async()=>{
 const f=await ready();finalizeRecognizedStored(f)
 const t=new Database(f.target);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:targetSchema})
 try{
 const inputs=[command(6,' 2 '),command(7,2),command(8,false),command(9,null),command(10,'   ')]
 const results=inputs.map(i=>writeRecognizedTarget(db,i))
 expect(t.prepare('SELECT exact_title_raw v,exact_title_state s,exact_title_origin o FROM platform_recognized_projection WHERE observation_id>5 ORDER BY observation_id').all()).toEqual([
 {v:'2',s:'captured',o:'commandInput'},{v:null,s:'captured',o:'commandInput'},{v:null,s:'captured',o:'commandInput'},{v:null,s:'captured',o:'commandInput'},{v:null,s:'captured',o:'commandInput'},
 ])
 const before=t.serialize()
 inputs.forEach((i,n)=>{expect(writeRecognizedTarget(db,i)).toMatchObject({...results[n],reused:true});verifyRecognizedStored(t,results[n]!.observationId);verifyFingerprint(t,{observationId:results[n]!.observationId,collectionId:1,relationAlias:results[n]!.relationAlias})})
 expect(t.serialize()).toEqual(before)
 }finally{t.close()}
})
it.each(['authenticated','recovered','receipt'])('rolls back the entire additive upgrade at injected %s failure and allows retry',async stage=>{
 const f=await ready();const t=new Database(f.target);const before=t.serialize();t.close()
 expect(()=>finalizeRecognizedStored({...f,beforeCommit:s=>{if(s===stage)throw new Error('injected')}})).toThrow('injected')
 const after=new Database(f.target);expect(after.serialize()).toEqual(before);after.close()
 expect(finalizeRecognizedStored(f).captured).toBe(5)
})
it('rejects wrong target bytes and changed successor cells on migration replay',async()=>{
 const f=await ready();const t=new Database(f.target);t.exec("UPDATE platform_recognized_projection SET title_raw='drift' WHERE observation_id=1");t.close()
 expect(()=>finalizeRecognizedStored(f)).toThrow('Unproven target facts/catalog')
 copyFileSync(f.source,f.target);finalizeRecognizedStored(f)
 const changed=new Database(f.target);changed.exec('DROP TRIGGER recognized_stored_update');changed.exec("UPDATE platform_recognized_projection SET exact_title_raw='drift' WHERE observation_id=1");changed.close()
 expect(()=>finalizeRecognizedStored(f)).toThrow()
})
it('rolls back new writer effects caught by outer savepoint and refuses immutable exact cell mutation',async()=>{
 const f=await ready();finalizeRecognizedStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:targetSchema})
 try{
 t.exec("CREATE TRIGGER injected_recognized BEFORE INSERT ON platform_recognized_projection WHEN NEW.observation_id>5 BEGIN SELECT RAISE(ABORT,'injected');END")
 const before=projectionManifest(t);const sequences=t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();db.transaction(tx=>expect(()=>writeRecognizedTarget(tx,command(6,'2'))).toThrow('injected'));expect(projectionManifest(t)).toEqual(before);expect(t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences)
 expect(()=>t.exec("UPDATE platform_recognized_projection SET exact_title_raw='drift' WHERE observation_id=1")).toThrow('immutable recognized stored title')
 }finally{t.close()}
})
it('keeps absent trusted snapshot uncaptured despite target residual title and rejects certification',async()=>{
 const f=await candidateFixture(old=>old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'recognized_list','Q','2','t','success','c');INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(1,1,1,'{"rdjb":"1"}','c');`),target=>{
 const triggers=target.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_observation_archive_ref'").all() as {name:string,sql:string}[]
 for(const r of triggers)target.exec(`DROP TRIGGER "${r.name}"`)
 target.exec("DELETE FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot';UPDATE platform_relation SET title_raw='residual' WHERE id=1")
 for(const r of triggers)target.exec(r.sql)
 })
 finalizeCandidateScopes(f);const source=join(f.root,'71609.sqlite');copyFileSync(f.target,source)
 expect(finalizeRecognizedStored({...f,source,runId:'recognized',predecessorRunId:'candidate'})).toMatchObject({captured:0,uncaptured:1})
 const t=new Database(f.target)
 try{expect(t.prepare('SELECT exact_title_raw v,exact_title_state s,exact_title_archive_id a FROM platform_recognized_projection').get()).toEqual({v:null,s:'uncaptured',a:null});expect(()=>verifyRecognizedStored(t,1)).toThrow('recognized_stored_uncaptured')}finally{t.close()}
})
it('keeps all other directory legacy cells in their own existing target owners without title substitution',async()=>{
 const f=await candidateFixture(old=>old.exec(`INSERT INTO enterprise(id,name,name_norm) VALUES(1,'Owner','owner');
 INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'recognized_list','Q','2,3','t','success','c');
 INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,name_raw,uscc_raw,enterprise_id,raw_fields,created_at) VALUES(1,1,1,'  key  ',' Original ',' U ',1,'{"rdjb":"1"}','c');
 UPDATE platform_relation SET title_raw=' 2 ';`))
 finalizeCandidateScopes(f);const source=join(f.root,'71609.sqlite');copyFileSync(f.target,source);finalizeRecognizedStored({...f,source,runId:'recognized',predecessorRunId:'candidate'})
 const old=new Database(f.legacySource,{readonly:true}),t=new Database(f.target,{readonly:true})
 try{
 const legacy=old.prepare('SELECT r.id,r.query_id,r.sequence_no,r.relation_key,r.name_raw,r.uscc_raw,r.enterprise_id,q.rdjb,q.query_key,q.queried_at,q.status FROM platform_relation r JOIN platform_query q ON q.id=r.query_id').get()
 const target=t.prepare('SELECT ra.old_id id,qa.old_id query_id,o.sequence_no,o.source_relation_key relation_key,a.name_raw,a.uscc_raw,a.enterprise_id,c.rdjb,c.query_key,c.queried_at,c.status FROM platform_business_observation o JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id JOIN platform_legacy_query_alias qa ON qa.collection_id=o.collection_id JOIN platform_collection c ON c.id=o.collection_id JOIN platform_observation_assignment a ON a.observation_id=o.id AND a.revision=1').get()
 expect(target).toEqual(legacy);expect(target).toMatchObject({relation_key:'  key  ',name_raw:' Original ',uscc_raw:' U ',rdjb:'2,3'})
 }finally{old.close();t.close()}
})
import { assertExpandRuntime } from '../db/schema-phase'
it('retains the global runtime guard and requires a distinct completed 71609 source before schema changes',async()=>{
 const f=await ready()
 expect(()=>finalizeRecognizedStored({...f,target:f.source})).toThrow('Distinct isolated')
 const t=new Database(f.target);t.pragma('user_version=71608');const before=t.serialize();t.close()
 expect(()=>finalizeRecognizedStored(f)).toThrow('Unproven target facts/catalog')
 const after=new Database(f.target);expect(after.serialize()).toEqual(before);after.close()
 copyFileSync(f.source,f.target);finalizeRecognizedStored(f)
 const guarded=new Database(f.target);try{expect(()=>assertExpandRuntime(guarded)).toThrow('W/R cutover required')}finally{guarded.close()}
})
it('refuses exact title drift during writer reuse and fingerprint certification without repairing it',async()=>{
 const f=await ready();finalizeRecognizedStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:targetSchema})
 try{
 const input=command(6,'2'),r=writeRecognizedTarget(db,input)
 const barrier=t.prepare("SELECT sql FROM sqlite_schema WHERE name='recognized_stored_update'").get() as {sql:string}
 t.exec("DROP TRIGGER recognized_stored_update;UPDATE platform_recognized_projection SET exact_title_raw='3' WHERE observation_id=6");t.exec(barrier.sql)
 const before=projectionManifest(t)
 expect(()=>writeRecognizedTarget(db,input)).toThrow('recognized_stored_cell_conflict')
 expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).toThrow('recognized_stored_cell_conflict')
 expect(projectionManifest(t)).toEqual(before)
 }finally{t.close()}
})
import { writeCollectionTarget } from '../lib/platform/collection-target-replay'
it('certifies original collection reference replay with independent stored title and refuses drift with its original alias',async()=>{
 const f=await ready();finalizeRecognizedStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:targetSchema})
 const input={queryText:JSON.stringify({interface:'recognized_list',queryKey:'Q',rdjb:'1,2,3',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1}]}),evidenceText:null,createdAt:'c',assignments:[]}
 try{
 expect(writeCollectionTarget(db,input)).toMatchObject({reused:true,observations:[{relationAlias:1,reused:true}]})
 t.exec("DROP TRIGGER recognized_stored_update;UPDATE platform_recognized_projection SET exact_title_raw='drift' WHERE observation_id=1")
 const before=projectionManifest(t)
 expect(()=>writeCollectionTarget(db,input)).toThrow('projection_source_drift')
 expect(projectionManifest(t)).toEqual(before)
 }finally{t.close()}
})
it('recovers pre-capture 71609 command title from bound original input without borrowing a shared version',async()=>{
 const f=await ready();const t=new Database(f.target);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:targetSchema})
 const r=writeRecognizedTarget(db,command(6,' 3 '));t.close()
 const source=join(f.root,'with-command.sqlite');copyFileSync(f.target,source)
 expect(finalizeRecognizedStored({...f,source})).toMatchObject({captured:6,uncaptured:0})
 const upgraded=new Database(f.target)
 try{expect(upgraded.prepare('SELECT exact_title_raw title,exact_title_origin origin,title_raw display FROM platform_recognized_projection WHERE observation_id=?').get(r.observationId)).toEqual({title:'3',origin:'commandInput',display:'3'});verifyRecognizedStored(upgraded,r.observationId)}finally{upgraded.close()}
})

import { fingerprintArchiveInventory } from '../lib/platform/fingerprint-schema-inventory'
it('rejects partial and unfinished exact catalogs before writer verifier or inventory can accept them',async()=>{
 const f=await ready()
 const mutations=[
  "ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_raw BLOB",
  "ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_state TEXT",
  "ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_raw BLOB;ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_state TEXT;ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_origin TEXT;ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_archive_id INTEGER REFERENCES platform_archive_value(id);ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_sha256 TEXT",
 ]
 for(const [i,ddl] of mutations.entries()){
  const path=join(f.root,`partial-${i}.sqlite`);copyFileSync(f.source,path)
  const t=new Database(path);t.pragma('foreign_keys=ON');t.exec(ddl)
  try{
   const before=t.serialize(),db=drizzle(t,{schema:targetSchema})
   expect(()=>writeRecognizedTarget(db,command(6,'3'))).toThrow('recognized_stored_schema')
   expect(()=>verifyFingerprint(t,{observationId:1,collectionId:1,relationAlias:1})).toThrow('recognized_stored_schema')
   expect(()=>fingerprintArchiveInventory(t)).toThrow('recognized_stored_schema')
   expect(t.serialize()).toEqual(before)
  }finally{t.close()}
 }
})
it('authenticates unindexed reference exact cells bindings and uncaptured state without repair',async()=>{
 const f=await ready();finalizeRecognizedStored(f)
 for(const change of ["exact_title_raw='BAD'","exact_title_sha256='BAD'","exact_title_state='uncaptured'"]){
  const path=join(f.root,`reference-${change.split('=')[0]}.sqlite`);copyFileSync(f.target,path)
  const t=new Database(path);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:targetSchema})
  const input={queryText:JSON.stringify({interface:'recognized_list',queryKey:'Q',rdjb:'1,2,3',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:3}]}),evidenceText:null,createdAt:'c',assignments:[]}
  try{
   expect(writeCollectionTarget(db,input)).toMatchObject({reused:true,observations:[{relationAlias:3,reused:true}]})
   const trigger=t.prepare("SELECT sql FROM sqlite_schema WHERE name='recognized_stored_update'").get() as {sql:string}
   t.exec(`DROP TRIGGER recognized_stored_update;UPDATE platform_recognized_projection SET ${change} WHERE observation_id=3`);t.exec(trigger.sql)
   const before=projectionManifest(t),sequences=t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
   let caught:unknown
   try{writeCollectionTarget(db,input)}catch(error){caught=error}
   expect(caught).toMatchObject({result:{ok:false,kind:'platform_relation',ref:'relation:3',error:{code:'projection_source_drift',field:'relations'}}})
   expect(projectionManifest(t)).toEqual(before);expect(t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences)
  }finally{t.close()}
 }
})
it('rejects incomplete receipts malformed barriers and wrong phase without changing facts',async()=>{
 const f=await ready();finalizeRecognizedStored(f)
 for(const [i,ddl] of [
  "DELETE FROM platform_migration_checkpoint WHERE run_id='recognized-stored'",
  "UPDATE platform_migration_run SET state='running' WHERE run_id='recognized-stored'",
  "DROP TRIGGER recognized_stored_insert",
  "DROP TRIGGER recognized_stored_update;CREATE TRIGGER recognized_stored_update BEFORE UPDATE ON platform_recognized_projection BEGIN SELECT 1;END",
  'PRAGMA user_version=71608',
 ].entries()){
  const path=join(f.root,`invalid-completion-${i}.sqlite`);copyFileSync(f.target,path)
  const t=new Database(path);t.pragma('foreign_keys=ON');t.exec(ddl)
  try{
   const before=t.serialize()
   expect(()=>writeRecognizedTarget(drizzle(t,{schema:targetSchema}),command(6,'3'))).toThrow()
   expect(()=>verifyRecognizedStored(t,1)).toThrow('recognized_stored_schema')
   expect(()=>fingerprintArchiveInventory(t)).toThrow('recognized_stored_schema')
   expect(t.serialize()).toEqual(before)
  }finally{t.close()}
 }
},30000)
