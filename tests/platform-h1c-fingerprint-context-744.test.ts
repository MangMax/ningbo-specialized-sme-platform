import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { processReaderFixture } from './helpers/process-target-734'
import { controlledH1cSuccessor } from './helpers/h1c-catalog-target'
import { emptyFingerprintTarget } from '../lib/platform/fingerprint-verifier'
import { verifyOriginalCommand } from '../lib/platform/fingerprint-command-facts'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { writeApplyTarget, type ApplyTargetInput } from '../lib/platform/apply-target-writer'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
import { targetSchema } from '../lib/platform/target-schema'
import { canonicalPlatformJson } from '../lib/platform/observation-plan'
import { inheritProcessStoredCatalog } from '../lib/platform/process-stored-catalog'
import { inheritRecognizedStoredCatalog } from '../lib/platform/recognized-stored-catalog'
import { inheritWitnessCatalog } from '../lib/platform/recognized-witness-catalog'
import { capturePhase } from '../lib/platform/fingerprint-capture'
import { fingerprintArchiveInventory } from '../lib/platform/fingerprint-schema-inventory'
import { projectionManifest } from '../upgrade/projections'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { verifyFingerprint } from '../lib/platform/fingerprint-verifier'
import { bootstrapFingerprint } from '../lib/platform/fingerprint-bootstrap'
import { isH1cFingerprintScratch } from '../lib/platform/h1c-fingerprint-context'
import { reconstructWitnessCollectionSource } from '../lib/platform/recognized-witness-write'

let f:Awaited<ReturnType<typeof processReaderFixture>>,target:Database.Database
const events:{source:string;input:ApplyTargetInput;observationId:number;relationAlias:number}[]=[]
beforeAll(async()=>{
 f=await processReaderFixture(false,old=>old.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(21,'recognized_list','proof-recognized_list','2','proof-time','success','c')"))
 f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=100 WHERE namespace='relation'")
 for(const [source,writer] of [['apply_list',writeApplyTarget],['business_list',writeProcessTarget],['recognized_list',writeRecognizedTarget]] as const){
  const collection=source==='recognized_list'?{collectionId:21}:writeNewCollectionTarget(f.db,{queryText:JSON.stringify({interface:source,queryKey:'proof-'+source,queriedAt:'proof-time',status:'success',rawResponse:'{}',relations:[]}),evidenceText:null,createdAt:'c',assignments:[]})
  const input:ApplyTargetInput={collectionId:collection.collectionId,position:{sequenceNo:1,positionState:'unknown'},row:{sequenceNo:1,relationKey:' '+source+' ',nameRaw:' Old ',usccRaw:' U ',status:' pending ',year:2024,rawFields:{z:1,id:source,rdjb:'2',cszt:'pending',year:2024}},assignment:{nameRaw:'Old',usccRaw:'U',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'a2b'},basis:'original'}}
  const result=writer(f.db,input)
  events.push({source,input,observationId:result.observationId,relationAlias:result.relationAlias})
 }
 const first=events[1]!,input:ApplyTargetInput={...first.input,position:{...first.input.position,sequenceNo:2},row:{...first.input.row,sequenceNo:2},assignment:{...first.input.assignment,basis:'second observation'}}
 const repeated=writeProcessTarget(f.db,input)
 events.push({source:'business_list-repeat',input,observationId:repeated.observationId,relationAlias:repeated.relationAlias})
 target=controlledH1cSuccessor(f)
})
function state(t:Database.Database){return {facts:projectionManifest(t),schema:schemaHash(t),ledger:t.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all(),checkpoints:t.prepare('SELECT * FROM platform_migration_checkpoint ORDER BY run_id,phase,source_table').all(),changes:t.prepare('SELECT total_changes() n').get()}}
function clone(scratch:Database.Database){const t=new Database(scratch.serialize());t.pragma('foreign_keys=ON');return t}
const entrypoints=[inheritProcessStoredCatalog,inheritRecognizedStoredCatalog,inheritWitnessCatalog]
it('retains all original bytes hashes and historical receipt cells through repeated source proof without primary writes',()=>{
 const before=state(target),old=state(f.t),scratch=emptyFingerprintTarget(target)
 try{
  for(const event of events){
   const bytes=verifyOriginalCommand(target,scratch,{observationId:event.observationId,originalInput:event.input})
   const row=target.prepare('SELECT input_fingerprint FROM platform_business_observation WHERE id=?').get(event.observationId)
   expect(row).toEqual({input_fingerprint:createHash('sha256').update(bytes).digest('hex')})
  }
  expect(state(target)).toEqual(before);expect(state(f.t)).toEqual(old)
 }finally{scratch.close()}
})
it('proves original commands on the actual accepted 71610 control through its unchanged reconstruction',()=>{
 const scratch=emptyFingerprintTarget(f.t)
 try{for(const event of events)expect(verifyOriginalCommand(f.t,scratch,{observationId:event.observationId,originalInput:event.input})).toEqual(Buffer.from(canonicalPlatformJson(event.input)))}finally{scratch.close()}
})
it('does not inherit a serialized clone by marker and rejects counterfeit source catalog or receipt with zero writes',()=>{
 const scratch=emptyFingerprintTarget(target),unbound=clone(scratch)
 try{
  expect(isH1cFingerprintScratch(unbound)).toBe(false)
  expect(()=>capturePhase(drizzle(unbound,{schema:targetSchema}),true)).toThrow()
  expect(()=>verifyOriginalCommand(target,unbound,{observationId:events[0]!.observationId,originalInput:events[0]!.input})).toThrow('h1c_fingerprint_context_missing')
  for(const sql of ["UPDATE platform_migration_run SET source_snapshot_sha256='"+'f'.repeat(64)+"' WHERE run_id='process'",'CREATE INDEX sqliteXfake ON enterprise(name)']){
   target.exec('BEGIN')
   try{
    target.exec(sql);const before=state(target)
    for(const inherit of entrypoints)expect(()=>inherit(target,unbound)).toThrow()
    expect(()=>emptyFingerprintTarget(target)).toThrow()
    expect(state(target)).toEqual(before)
   }finally{target.exec('ROLLBACK')}
  }
 }finally{scratch.close();unbound.close()}
})
it.each([
 ['business rows',"INSERT INTO enterprise(name,name_norm) VALUES('unexpected','unexpected')"],
 ['title rows',"INSERT INTO title(code,name_zh,level,rank) VALUES('unexpected','x','municipal',4)"],
 ['autoincrement sequence',"INSERT INTO sqlite_sequence(name,seq) VALUES('enterprise',99)"],
 ['nonzero alias highwater',"UPDATE platform_legacy_alias_sequence SET high_water=1 WHERE namespace='relation'"],
] as const)('all inheritance owners require fully empty reconstruction including %s',(_name,sql)=>{
 const scratch=emptyFingerprintTarget(target),bad=clone(scratch)
 try{bad.exec(sql);const before=state(bad);for(const inherit of entrypoints)expect(()=>inherit(target,bad)).toThrow(/h1c_fingerprint_empty/);expect(state(bad)).toEqual(before);expect(isH1cFingerprintScratch(bad)).toBe(false)}finally{bad.close();scratch.close()}
})
it('refuses disk-backed FK-OFF and foreign-phase reconstructions without granting a capability',()=>{
 const scratch=emptyFingerprintTarget(target),off=clone(scratch),phase=clone(scratch),path=join(f.root,'untrusted-staging.sqlite')
 writeFileSync(path,scratch.serialize());const disk=new Database(path);disk.pragma('foreign_keys=ON')
 try{
  off.pragma('foreign_keys=OFF');phase.pragma('user_version=71610')
  for(const bad of [off,phase,disk]){for(const inherit of entrypoints)expect(()=>inherit(target,bad)).toThrow('h1c_fingerprint_empty_catalog');expect(isH1cFingerprintScratch(bad)).toBe(false)}
 }finally{off.close();phase.close();disk.close();scratch.close()}
})
it.each(['CREATE INDEX unexpected ON enterprise(name)','CREATE INDEX sqliteXhidden ON enterprise(name)','PRAGMA user_version=71610','PRAGMA foreign_keys=OFF'])('revalidates registered scratch after %s',sql=>{
 const scratch=emptyFingerprintTarget(target)
 try{scratch.exec(sql);expect(()=>isH1cFingerprintScratch(scratch)).toThrow('h1c_fingerprint_context_drift');expect(()=>verifyOriginalCommand(target,scratch,{observationId:events[0]!.observationId,originalInput:events[0]!.input})).toThrow('h1c_fingerprint_context_drift')}finally{scratch.close()}
})
it('binds the complete exact source ledger instead of merely a valid source schema marker',()=>{
 const scratch=emptyFingerprintTarget(target)
 target.exec('BEGIN')
 try{
  target.exec("INSERT INTO platform_migration_run SELECT 'extra-unbound',source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,'unbound-test',state FROM platform_migration_run WHERE run_id='h1c'")
  expect(()=>verifyOriginalCommand(target,scratch,{observationId:events[0]!.observationId,originalInput:events[0]!.input})).toThrow('h1c_fingerprint_source_binding')
 }finally{target.exec('ROLLBACK');scratch.close()}
})
it('rejects changed original input owner coordinates and alias mappings instead of authorizing another observation',()=>{
 const scratch=emptyFingerprintTarget(target),event=events[1]!
 try{
  for(const input of [{...event.input,assignment:{...event.input.assignment,basis:'changed'}},{...event.input,collectionId:events[0]!.input.collectionId}])expect(()=>verifyOriginalCommand(target,scratch,{observationId:event.observationId,originalInput:input})).toThrow(/fingerprint|owner/)
  target.exec('BEGIN')
  try{mutate(`DELETE FROM platform_legacy_relation_alias WHERE observation_id=${event.observationId}`,'platform_legacy_relation_alias');expect(()=>verifyOriginalCommand(target,scratch,{observationId:event.observationId,originalInput:event.input})).toThrow(/alias/)}finally{target.exec('ROLLBACK')}
 }finally{scratch.close()}
})
function mutate(sql:string,table:string){
 const triggers=z.array(z.object({name:z.string(),sql:z.string()})).parse(target.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table))
 for(const row of triggers)target.exec('DROP TRIGGER "'+row.name.replaceAll('"','""')+'"')
 try{target.exec(sql)}finally{for(const row of triggers)target.exec(row.sql)}
}
it.each(['exact_status','exact_stored_state','sql_fact_title'])('checks actual stored process %s before certifying original command bytes',field=>{
 const scratch=emptyFingerprintTarget(target),event=events[1]!
 target.exec('BEGIN');target.pragma('defer_foreign_keys=ON')
 try{
  const values=field==='exact_stored_state'?"exact_stored_state='uncaptured',exact_status=NULL,exact_declare_kind=NULL,exact_applied_at=NULL,exact_year=NULL,exact_title_raw=NULL,exact_batch=NULL,exact_award_batch_label=NULL,exact_province=NULL,exact_stored_rule=NULL,exact_stored_origin=NULL,exact_stored_reason='controlled uncaptured'":`${field}='changed'`
  mutate(`UPDATE platform_business_projection SET ${values} WHERE observation_id=${event.observationId}`,'platform_business_projection')
  const before=state(target)
  expect(()=>verifyOriginalCommand(target,scratch,{observationId:event.observationId,originalInput:event.input})).toThrow(field==='exact_stored_state'?'process_stored_uncaptured':/process_stored_conflict/)
  expect(state(target)).toEqual(before)
 }finally{target.exec('ROLLBACK');scratch.close()}
})
it('keeps main fingerprint capture verifier bootstrap and three source writers unsupported while internal reconstruction works',()=>{
 const db=drizzle(target,{schema:targetSchema}),before=state(target)
 for(const [index,writer] of [writeApplyTarget,writeProcessTarget,writeRecognizedTarget].entries()){
  const event=events[index]!,owner={observationId:event.observationId,collectionId:event.input.collectionId,relationAlias:event.relationAlias}
  expect(()=>writer(db,event.input)).toThrow('Explicit finalized target required')
  expect(()=>bootstrapFingerprint(target,owner,'ordinary')).toThrow('Explicit finalized target required')
  expect(()=>verifyFingerprint(target,owner)).toThrow('Explicit 71607 verifier target required')
 }
 expect(()=>capturePhase(db,true)).toThrow('Explicit finalized target required')
 expect(state(target)).toEqual(before)
})
it('keeps same-version observations distinct and rejects the other observation original input',()=>{
 const first=events[1]!,second=events[3]!,scratch=emptyFingerprintTarget(target)
 try{
  const ids=(id:number)=>target.prepare('SELECT record_id,version_id FROM platform_business_observation WHERE id=?').get(id)
  expect(ids(first.observationId)).toMatchObject({record_id:expect.any(Number),version_id:expect.any(Number)})
  expect(ids(first.observationId)).toEqual(ids(second.observationId))
  expect(first.observationId).not.toBe(second.observationId)
  expect(()=>verifyOriginalCommand(target,scratch,{observationId:first.observationId,originalInput:second.input})).toThrow('Command owner/rule conflict')
 }finally{scratch.close()}
})
it('uses one authenticated command-proof snapshot and rejects the next request with the stale source context',()=>{
 const event=events[0]!,scratch=emptyFingerprintTarget(target),before=state(target)
 target.pragma('journal_mode=WAL')
 const writer=new Database(target.name)
 let changed=false
 const reader=new Database(target.name,{verbose:query=>{
  if(!changed&&typeof query==='string'&&/^select/i.test(query)&&query.includes('from "platform_business_observation"')){
   writer.exec("INSERT INTO platform_migration_run SELECT 'concurrent-extra',source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,'unbound-test',state FROM platform_migration_run WHERE run_id='h1c'");changed=true
  }
 }})
 try{
  expect(verifyOriginalCommand(reader,scratch,{observationId:event.observationId,originalInput:event.input})).toEqual(Buffer.from(canonicalPlatformJson(event.input)))
  expect(changed).toBe(true)
  expect(()=>verifyOriginalCommand(reader,scratch,{observationId:event.observationId,originalInput:event.input})).toThrow('h1c_fingerprint_source_binding')
 }finally{reader.close();writer.exec("DELETE FROM platform_migration_run WHERE run_id='concurrent-extra'");writer.close();scratch.close()}
 expect(state(target)).toEqual(before)
})
it('authenticates the complete archive inventory and preserves independently literal raw JSON insertion-order bytes',()=>{
 expect(fingerprintArchiveInventory(target)).toEqual(fingerprintArchiveInventory(f.t))
 expect(fingerprintArchiveInventory(target)).toContain('platform_business_observation.candidate_scope_archive_id')
 const event=events[1]!,raw=target.prepare("SELECT a.bytes,a.sha256 FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field='rawFields'").get(event.observationId)
 const bytes=Buffer.from('{"z":1,"id":"business_list","rdjb":"2","cszt":"pending","year":2024}')
 expect(raw).toEqual({bytes,sha256:createHash('sha256').update(bytes).digest('hex')})
})
it('rejects corrupted revision1 and altered source bytes with recomputed archive hash rather than repairing either',()=>{
 const event=events[1]!,scratch=emptyFingerprintTarget(target),hash=createHash('sha256').update('{}').digest('hex')
 for(const [table,sql] of [
  ['platform_observation_assignment',`UPDATE platform_observation_assignment SET basis='changed' WHERE observation_id=${event.observationId} AND revision=1`],
  ['platform_archive_value',`UPDATE platform_archive_value SET bytes=CAST('{}' AS BLOB),byte_length=2,sha256='${hash}' WHERE id=(SELECT archive_id FROM platform_observation_archive_ref WHERE owner_id=${event.observationId} AND field='rawFields')`],
 ] as const){
  target.exec('BEGIN')
  try{mutate(sql,table);const before=state(target);expect(()=>verifyOriginalCommand(target,scratch,{observationId:event.observationId,originalInput:event.input})).toThrow(/revision1|source|process_stored/);expect(state(target)).toEqual(before)}finally{target.exec('ROLLBACK')}
 }
 scratch.close()
})
it('reconstructs witness source only in a source-bound private context preserving collection archive identity and bytes',()=>{
 const event=events[2]!,scratch=emptyFingerprintTarget(target),unbound=clone(scratch),before=state(target)
 try{
  expect(()=>reconstructWitnessCollectionSource(target,unbound,event.input.collectionId)).toThrow('h1c_fingerprint_context_missing')
  const db=drizzle(scratch,{schema:targetSchema}),collection=f.db.select().from(targetSchema.platformCollection).where(eq(targetSchema.platformCollection.id,event.input.collectionId)).get()!
  db.insert(targetSchema.platformCollection).values(collection).run()
  reconstructWitnessCollectionSource(target,scratch,event.input.collectionId)
  const fields=(t:Database.Database)=>t.prepare('SELECT witness_state,witness_gate,witness_archive_id,witness_sha256 FROM platform_collection WHERE id=?').get(event.input.collectionId)
  expect(fields(scratch)).toEqual(fields(target))
  const archive=(t:Database.Database)=>t.prepare("SELECT r.*,a.storage_class,hex(a.bytes) bytes,a.sha256 FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field='collectionEvidence'").all(event.input.collectionId)
  expect(archive(scratch)).toEqual(archive(target))
  expect(state(target)).toEqual(before)
 }finally{scratch.close();unbound.close()}
})
it('rejects replay materialization from a previously populated reconstruction template',()=>{
 const scratch=emptyFingerprintTarget(target),before=state(target)
 try{
  scratch.exec("INSERT INTO enterprise(name,name_norm) VALUES('not empty','not empty')")
  expect(()=>verifyOriginalCommand(target,scratch,{observationId:events[0]!.observationId,originalInput:events[0]!.input})).toThrow('h1c_fingerprint_empty_data')
  expect(state(target)).toEqual(before)
 }finally{scratch.close()}
})
afterAll(()=>{target?.close();f?.close()})
it('authenticates a wholly empty private successor reconstruction and proves all three original commands with divergent IDs',()=>{
 const scratch=emptyFingerprintTarget(target)
 try{
  expect(scratch.memory).toBe(true)
  expect(scratch.prepare('SELECT count(*) n FROM platform_business_observation').get()).toEqual({n:0})
  for(const event of events){
   expect(event.observationId).toBeGreaterThan(1)
   expect(event.relationAlias).not.toBe(event.observationId)
   expect(verifyOriginalCommand(target,scratch,{observationId:event.observationId,originalInput:event.input})).toEqual(Buffer.from(canonicalPlatformJson(event.input)))
  }
 }finally{scratch.close()}
})
