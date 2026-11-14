import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { captureSqlFactTitle } from '../upgrade/apply-stored-cells'

it.each([
  ['{"rdjb":"2","rdjb":"3"}', '2'],
  ['{"rdjb":"1","rdjb":"3"}', '1'],
  ['{"rdjb":"3","rdjb":"2"}', '3'],
  ['{"rdjb":2,"rdjb":"3"}', null],
  ['{"rd\\u006ab":"2","rdjb":"3"}', '2'],
  ['[{"rdjb":"2"}]', null], ['invalid', null], [null, null],
  ['{"rdjb":" \\t2 \\n"}', '2'], ['{"rdjb":" \\t "}', null],
])('captures old SQLite fact-title grammar from original cell %s', (raw, expected) => {
  const t = new Database(':memory:')
  // Frozen old expression, independent of the new capture implementation.
  const row = t.prepare(`SELECT CASE WHEN json_valid(@raw) THEN CASE WHEN json_type(@raw,'$.rdjb')='text' THEN json_extract(@raw,'$.rdjb') ELSE NULL END ELSE NULL END AS title`).get({raw}) as {title: string|null}
  const old = typeof row.title === 'string' ? row.title.trim() || null : null
  expect(old).toBe(expected)
  expect(captureSqlFactTitle(t, raw)).toBe(expected)
  t.close()
})

import { installApplyStoredSchema } from '../upgrade/apply-stored-schema'
it('requires FK ON and a caller transaction before any successor DDL', () => {
  const t = new Database(':memory:')
  t.pragma('foreign_keys=OFF')
  const before = t.serialize()
  expect(() => installApplyStoredSchema(t)).toThrow(/foreign_keys/)
  expect(t.serialize()).toEqual(before)
  t.pragma('foreign_keys=ON')
  expect(() => installApplyStoredSchema(t)).toThrow(/transaction/)
  t.close()
})

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../upgrade/finalize-observations'
import { finalizeFingerprintBasis } from '../upgrade/fingerprint-basis'
import { finalizeApplyStored } from '../upgrade/apply-stored'
function fixture(indexed=false) {
 const root=mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR??tmpdir(),'apply-stored-'))
 const legacy=join(root,'legacy.sqlite'),target=join(root,'target.sqlite'),source=join(root,'71607.sqlite')
 const s=new Database(legacy);migrate(drizzle(s),{migrationsFolder:'db/migrations'})
 s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'apply_list','Q','2','t','success','c');
 INSERT INTO platform_relation(id,query_id,sequence_no,status,raw_fields,created_at) VALUES(1,1,1,' pending ','{"rdjb":"2","rdjb":"3","cszt":"pending"}','c'),(2,1,2,'pending','{"rdjb":"1","rdjb":"3","cszt":"pending"}','c');
 UPDATE platform_relation SET title_raw='X';`)
 if(indexed){s.exec("UPDATE platform_relation SET raw_fields='{\"cszt\":\"pending\",\"rdjb\":\"2\"}'; UPDATE platform_relation SET title_raw='X'");const db=drizzle(s,{schema:expandSchema});ensurePlatformObservation(db,1);ensurePlatformObservation(db,2)}
 s.close();copyFileSync(legacy,target)
 upgradeCollections({source:legacy,target,runId:'collections',batchSize:10})
 upgradeObservations({source:legacy,target,runId:'observations',collectionRunId:'collections',batchSize:10})
 upgradeProjections({source:legacy,target,runId:'projections',observationRunId:'observations',collectionRunId:'collections',batchSize:10})
 const opts={source:legacy,target,runId:'final',projectionRunId:'projections',observationRunId:'observations',collectionRunId:'collections'}
 finalizeObservations(opts);finalizeCollectionScopes({...opts,runId:'scopes',finalizationRunId:'final'})
 const p=join(root,'71606.sqlite');copyFileSync(target,p)
 finalizeFingerprintBasis({source:p,target,runId:'basis',predecessorRunId:'scopes',legacySource:legacy})
 copyFileSync(target,source)
 return {source,target,legacySource:legacy,runId:'stored',predecessorRunId:'basis'}
}
it('upgrades original status pair and duplicate-key SQL facts independently without rewriting old cells',()=>{
 const f=fixture()
 const result=finalizeApplyStored(f)
 expect(result.queryReady).toBe(true)
 const t=new Database(f.target)
 expect(t.pragma('user_version',{simple:true})).toBe(71608)
 expect(t.prepare('SELECT exact_status,exact_title_raw,sql_fact_title,exact_stored_state,sql_fact_title_state,stored_status FROM platform_apply_projection WHERE observation_id IS NOT NULL ORDER BY observation_id').all()).toEqual([
  {exact_status:' pending ',exact_title_raw:'X',sql_fact_title:'2',exact_stored_state:'captured',sql_fact_title_state:'captured',stored_status:'pending'},
  {exact_status:'pending',exact_title_raw:'X',sql_fact_title:'1',exact_stored_state:'captured',sql_fact_title_state:'captured',stored_status:'pending'},
 ])
 expect(t.prepare("SELECT observation_id FROM platform_apply_projection WHERE exact_status='pending'").all()).toEqual([{observation_id:2}])
 expect(t.prepare('SELECT DISTINCT exact_status FROM platform_apply_projection ORDER BY exact_status COLLATE BINARY').all()).toEqual([{exact_status:' pending '},{exact_status:'pending'}])
 expect(t.pragma('foreign_key_check')).toEqual([])
 const bytes=t.serialize();t.close()
 expect(finalizeApplyStored(f).queryReady).toBe(true)
 const again=new Database(f.target);expect(again.serialize()).toEqual(bytes);again.close()
})

it.each(['authenticated','dropped','created','copied:platform_business_observation','copied:platform_apply_projection','copied:platform_business_projection','copied:platform_legacy_relation_alias','copied:platform_observation_archive_ref','copied:platform_observation_assignment','copied:platform_recognized_projection','copied:platform_observation_fingerprint_basis','restored','recovered','barrier','receipt'])('rolls back populated DDL and every incoming owner at %s',stage=>{
 const f=fixture();const before=new Database(f.target);const bytes=before.serialize();before.close()
 expect(()=>finalizeApplyStored({...f,beforeCommit:s=>{if(s===stage)throw new Error('injected '+stage)}})).toThrow('injected '+stage)
 const t=new Database(f.target);expect(t.serialize()).toEqual(bytes);expect(t.pragma('user_version',{simple:true})).toBe(71607);t.close()
})
it.each([0,1])('rejects update delete replace and upsert with recursive triggers %i',recursive=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');t.pragma(`recursive_triggers=${recursive}`)
 const before=t.serialize()
 for(const sql of [
  "UPDATE platform_apply_projection SET exact_status='changed'", "DELETE FROM platform_apply_projection",
  'INSERT OR REPLACE INTO platform_apply_projection SELECT * FROM platform_apply_projection',
  'INSERT INTO platform_apply_projection SELECT * FROM platform_apply_projection WHERE true ON CONFLICT(id) DO NOTHING',
  "UPDATE platform_business_observation SET apply_sql_fact_title_state='uncaptured'",
  'INSERT OR REPLACE INTO platform_business_observation SELECT * FROM platform_business_observation',
 ])expect(()=>t.exec(sql),sql).toThrow()
 expect(t.serialize()).toEqual(before);t.close()
})

import { createHash } from 'node:crypto'
function beginNewOwner(t:Database.Database) {
 t.exec('BEGIN; PRAGMA defer_foreign_keys=ON; SAVEPOINT nested')
 const bytes=Buffer.from('{}'),digest=createHash('sha256').update(bytes).digest('hex')
 t.prepare("INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256) VALUES(10000,'blob',?,2,?)").run(bytes,digest)
 t.exec("INSERT INTO platform_observation_fingerprint_basis VALUES(100,'target-command-v1',10000)")
 const columns=(t.pragma('table_info(platform_observation_assignment)') as {name:string}[]).map(c=>c.name)
 t.exec(`INSERT INTO platform_observation_assignment(${columns.join(',')}) SELECT ${columns.map(c=>c==='observation_id'?'100':c).join(',')} FROM platform_observation_assignment WHERE observation_id=1 AND revision=1`)
 t.exec("INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at,apply_exact_owner_id,apply_exact_state,apply_sql_fact_title_state) VALUES(100,1,100,'unknown','not_indexed','not_indexed',NULL,100,'captured','captured')")
}
it('defers missing entire projection past RELEASE and rejects outer COMMIT without discarding caller rollback',()=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');const bytes=t.serialize()
 beginNewOwner(t);t.exec('RELEASE nested')
 expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);expect(t.inTransaction).toBe(true)
 t.exec('ROLLBACK');expect(t.serialize()).toEqual(bytes);t.close()
})
it.each([['captured','uncaptured'],['uncaptured','captured'],['uncaptured','uncaptured']])('requires both captured states at outer COMMIT even when exact=%s/title=%s',(state,titleState)=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
 beginNewOwner(t)
 // A new archive is bound/sealed to this exact owner; clone old parsed cells independently.
 t.exec(`INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) SELECT 10001,storage_class,bytes,byte_length,sha256,created_at FROM platform_archive_value WHERE id=(SELECT source_archive_id FROM platform_apply_projection WHERE observation_id=1);
 INSERT INTO platform_observation_archive_ref(owner_id,field,archive_id) VALUES(100,'rawFields',10001);
 UPDATE platform_observation_archive_ref SET sealed=1 WHERE owner_id=100;`)
 const cols=(t.pragma('table_info(platform_apply_projection)') as {name:string}[]).map(c=>c.name)
 const overrides:Record<string,string>={id:'100',observation_id:'100',source_archive_id:'10001',exact_stored_state:`'${state}'`,sql_fact_title_state:`'${titleState}'`,...(titleState==='uncaptured'?{sql_fact_title:'NULL',sql_fact_title_rule:'NULL',sql_fact_title_reason:"'probe'"}:{})}
 if(state==='uncaptured')for(const name of ['exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','exact_stored_rule','exact_stored_origin'])overrides[name]='NULL'
 if(state==='uncaptured')overrides.exact_stored_reason="'probe'"
 t.exec(`INSERT INTO platform_apply_projection(${cols.join(',')}) SELECT ${cols.map(c=>overrides[c]??c).join(',')} FROM platform_apply_projection WHERE observation_id=1`)
 t.exec('RELEASE nested');expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);t.exec('ROLLBACK');t.close()
})

import { writeApplyTarget } from '../upgrade/frozen/apply-target-writer'
import { targetSchema } from '../lib/platform/target-schema'
it.each(['missing','different'])('records command materialization profile and rejects %s profile on replay without rewriting original input',drift=>{
 const f=fixture();const t=new Database(f.target);t.pragma('foreign_keys=ON')
 const result=writeApplyTarget(drizzle(t,{schema:targetSchema}),{collectionId:1,position:{sequenceNo:3,positionState:'unknown'},row:{sequenceNo:3,status:' pending ',year:2024,rawFields:{id:'A',cszt:'pending',rdjb:' 2 '}},assignment:{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'S-test'},basis:'explicit'}})
 const original=t.prepare('SELECT input_fingerprint,indexed_at FROM platform_business_observation WHERE id=?').get(result.observationId)
 t.close();copyFileSync(f.target,f.source)
 const receipt=finalizeApplyStored(f)
 expect(receipt.recovery).toContainEqual(expect.objectContaining({observationId:result.observationId,origin:'command_materialized',exactState:'captured',materializationRule:'legacy-apply-insert-v1'}))
 const next=new Database(f.target)
 expect(next.prepare('SELECT exact_status,exact_year,exact_title_raw,sql_fact_title FROM platform_apply_projection WHERE observation_id=?').get(result.observationId)).toEqual({exact_status:'pending',exact_year:2024,exact_title_raw:'2',sql_fact_title:'2'})
 expect(next.prepare('SELECT input_fingerprint,indexed_at FROM platform_business_observation WHERE id=?').get(result.observationId)).toEqual(original)
 expect(next.prepare('SELECT exact_stored_state,sql_fact_title_state,exact_status FROM platform_apply_projection WHERE version_id IS NOT NULL').all()).toEqual([{exact_stored_state:null,sql_fact_title_state:null,exact_status:null}])
 expect(()=>next.exec("INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state) VALUES(99,1,4,'unknown','not_indexed','not_indexed')")).toThrow()
 expect(next.prepare("SELECT source_table,copied_count FROM platform_migration_checkpoint WHERE run_id=? AND phase='apply-materialization'").get(f.runId)).toEqual({source_table:'legacy-apply-insert-v1',copied_count:1})
 const beforeReplay=next.serialize();next.close()
 expect(finalizeApplyStored(f)).toEqual(receipt)
 const changed=new Database(f.target);expect(changed.serialize()).toEqual(beforeReplay)
 if(drift==='missing')changed.prepare("DELETE FROM platform_migration_checkpoint WHERE run_id=? AND phase='apply-materialization'").run(f.runId)
 else changed.prepare("UPDATE platform_migration_checkpoint SET source_table='other-rule' WHERE run_id=? AND phase='apply-materialization'").run(f.runId)
 const beforeRefusal=changed.serialize();changed.close()
 expect(()=>finalizeApplyStored(f)).toThrow(/checkpoint drift/)
 const refused=new Database(f.target);expect(refused.serialize()).toEqual(beforeRefusal);refused.close()
})
it('recovers sealed snapshot alone and refuses source/snapshot contradiction atomically',()=>{
 const f=fixture();expect(finalizeApplyStored({...f,legacySource:undefined}).queryReady).toBe(true)
 const other=fixture();const legacy=new Database(other.legacySource);legacy.exec("UPDATE platform_relation SET status='changed' WHERE id=1");legacy.close()
 const t=new Database(other.target),before=t.serialize();t.close()
 expect(()=>finalizeApplyStored(other)).toThrow(/source\/snapshot conflict|provenance binding conflict/)
 const unchanged=new Database(other.target);expect(unchanged.serialize()).toEqual(before);unchanged.close()
})
it('rejects unknown incoming FK owners before DDL and retains predecessor bytes',()=>{
 const f=fixture();for(const file of [f.source,f.target]){const t=new Database(file);t.exec('CREATE TABLE unexpected_owner(id INTEGER REFERENCES platform_business_observation(id))');t.close()}
 // The unchanged predecessor schema receipt itself rejects this catalog drift.
 const t=new Database(f.target),before=t.serialize();t.close()
 expect(()=>finalizeApplyStored(f)).toThrow(/predecessor/)
 const unchanged=new Database(f.target);expect(unchanged.serialize()).toEqual(before);unchanged.close()
})

function newProjection(t:Database.Database,overrides:Record<string,string>={}) {
 t.exec(`INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) SELECT 10001,storage_class,bytes,byte_length,sha256,created_at FROM platform_archive_value WHERE id=(SELECT source_archive_id FROM platform_apply_projection WHERE observation_id=1);
 INSERT INTO platform_observation_archive_ref(owner_id,field,archive_id) VALUES(100,'rawFields',10001);
 UPDATE platform_observation_archive_ref SET sealed=1 WHERE owner_id=100;`)
 const cols=(t.pragma('table_info(platform_apply_projection)') as {name:string}[]).map(c=>c.name)
 const mapping={id:'100',observation_id:'100',source_archive_id:'10001',...overrides}
 t.exec(`INSERT INTO platform_apply_projection(${cols.join(',')}) SELECT ${cols.map(c=>Object.hasOwn(mapping,c)?mapping[c as keyof typeof mapping]:c).join(',')} FROM platform_apply_projection WHERE observation_id=1`)
}
it('commits a complete dual-captured deferred pair and preserves all SQLite affinity classes and REAL bits',()=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
 const cells=[['NULL','null',''],["''",'text',''],["' pending '",'text','2070656E64696E6720'],['2024','integer','32303234'],['2024.5','real','323032342E35'],["'bad'",'text','626164'],["X'32303234'",'blob','32303234'],["X''",'blob',''],["CAST(X'610062' AS TEXT)",'text','610062'],['9007199254740992','integer','39303037313939323534373430393932']] as const
 for(const [value,kind,hex] of cells) {
  beginNewOwner(t);newProjection(t,{exact_year:value})
  expect(t.prepare('SELECT typeof(exact_year) kind,hex(cast(exact_year AS blob)) hex FROM platform_apply_projection WHERE observation_id=100').get()).toEqual({kind,hex})
  expect(t.pragma('foreign_key_check')).toEqual([])
  t.exec('RELEASE nested; ROLLBACK')
 }
 beginNewOwner(t);newProjection(t);t.exec('RELEASE nested; COMMIT')
 expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
it('refuses uncaptured new observations and non-apply pair references before INSERT',()=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
 for(const state of ['NULL',"'uncaptured'"])expect(()=>t.exec(`INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at,apply_exact_owner_id,apply_exact_state,apply_sql_fact_title_state) VALUES(100,1,100,'unknown','not_indexed','not_indexed',NULL,100,${state},'captured')`)).toThrow()
 drizzle(t,{schema:targetSchema}).insert(targetSchema.platformCollection).values({id:20,interface:'business_list',queryKey:'B',rdjb:'',queriedAt:'t',status:'success',createdAt:'c',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'test'}).run()
 expect(()=>t.exec("INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at,apply_exact_owner_id,apply_exact_state,apply_sql_fact_title_state) VALUES(100,20,100,'unknown','not_indexed','not_indexed',NULL,100,'captured','captured')")).toThrow()
 t.close()
})

import { execFileSync } from 'node:child_process'
it('independently replays the fixed snapshot in a new process',()=>{
 const f=fixture()
 const result=finalizeApplyStored(f)
 const t=new Database(f.target),before=t.serialize();t.close()
 const output=execFileSync(process.execPath,['upgrade/run-apply-stored.mjs',f.source,f.target,f.target+'.replay-evidence',f.runId,f.predecessorRunId,f.legacySource],{encoding:'utf8'})
 expect(JSON.parse(output).manifest).toBe(result.manifest)
 const again=new Database(f.target);expect(again.serialize()).toEqual(before);again.close()
})
it('classifies invalid sealed snapshot encoding as uncaptured, independently retaining captured SQL NULL/text',()=>{
 const f=fixture()
 for(const path of [f.source,f.target]) {
  const t=new Database(path)
  const triggers=t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_archive_value'").all() as {name:string,sql:string}[]
  for(const r of triggers)t.exec(`DROP TRIGGER "${r.name}"`)
  const bytes=Buffer.from('{invalid')
  t.prepare("UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id IN (SELECT archive_id FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot')").run(bytes,bytes.length,createHash('sha256').update(bytes).digest('hex'))
  for(const r of triggers)t.exec(r.sql)
  t.close()
 }
 const result=finalizeApplyStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(false)
 expect(result.recovery.map(r=>[r.exactState,r.titleState,r.reason])).toEqual([['uncaptured','captured','invalid-snapshot-encoding'],['uncaptured','captured','invalid-snapshot-encoding']])
 const t=new Database(f.target)
 expect(t.prepare('SELECT exact_status,exact_stored_state,sql_fact_title FROM platform_apply_projection ORDER BY observation_id').all()).toEqual([{exact_status:null,exact_stored_state:'uncaptured',sql_fact_title:'2'},{exact_status:null,exact_stored_state:'uncaptured',sql_fact_title:'1'}])
 t.close()
})
it('rejects successor checkpoint and exact-cell drift on restart rather than trusting rowcount',()=>{
 const f=fixture();finalizeApplyStored(f)
 const t=new Database(f.target);t.exec("UPDATE platform_migration_checkpoint SET copied_count=copied_count+1 WHERE run_id='stored'");t.close()
 expect(()=>finalizeApplyStored(f)).toThrow(/checkpoint drift/)
})
it('retains incompatible preexisting command revision1/key as uncaptured without rewriting provenance',()=>{
 const f=fixture();const t=new Database(f.target);t.pragma('foreign_keys=ON')
 const result=writeApplyTarget(drizzle(t,{schema:targetSchema}),{collectionId:1,position:{sequenceNo:3,positionState:'unknown'},row:{sequenceNo:3,relationKey:' K ',nameRaw:' A ',rawFields:{rdjb:'2'}},assignment:{nameRaw:' A ',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'S-test'},basis:'explicit'}})
 t.close();copyFileSync(f.target,f.source)
 const receipt=finalizeApplyStored(f)
 expect(receipt.queryReady).toBe(false)
 expect(receipt.recovery).toContainEqual(expect.objectContaining({observationId:result.observationId,exactState:'uncaptured',reason:'command-materialization-revision1-or-key-incompatible'}))
 const next=new Database(f.target)
 expect(next.prepare('SELECT source_relation_key FROM platform_business_observation WHERE id=?').get(result.observationId)).toEqual({source_relation_key:' K '})
 expect(next.prepare('SELECT name_raw FROM platform_observation_assignment WHERE observation_id=? AND revision=1').get(result.observationId)).toEqual({name_raw:' A '});next.close()
})

import { statSync, readFileSync } from 'node:fs'
import { serialize } from 'node:v8'
it('preserves TEXT affinities including NUL and BLOB in each exact text cell, and captured all-NULL cells',()=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
 for(const field of ['exact_status','exact_declare_kind','exact_applied_at','exact_title_raw'])for(const [value,kind,hex] of [['NULL','null',''],["''",'text',''],['2024','text','32303234'],['2024.5','text','323032342E35'],["X''",'blob',''],["X'610062'",'blob','610062'],["CAST(X'610062' AS TEXT)",'text','610062']] as const){
  beginNewOwner(t);newProjection(t,{[field]:value})
  expect(t.prepare(`SELECT typeof(${field}) kind,hex(cast(${field} AS blob)) hex FROM platform_apply_projection WHERE observation_id=100`).get()).toEqual({kind,hex})
  t.exec('RELEASE nested; ROLLBACK')
 }
 beginNewOwner(t);newProjection(t,Object.fromEntries(['exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw'].map(c=>[c,'NULL'])))
 expect(t.prepare('SELECT exact_stored_state FROM platform_apply_projection WHERE observation_id=100').get()).toEqual({exact_stored_state:'captured'})
 t.exec('RELEASE nested; COMMIT');t.close()
})

import * as expandSchema from '../upgrade/legacy-schema'
import { ensurePlatformObservation } from '../upgrade/frozen/server/platform-business-record'
import { listPlatformDeclarations } from '../upgrade/frozen/server/platform-declarations'
import { readPlatformFilterOptions } from '../upgrade/frozen/server/platform-filter-options'
it('matches independent old public isolated total1/options2 on same-raw indexed status pair',()=>{
 const f=fixture(true),old=new Database(f.legacySource,{readonly:true}),db=drizzle(old,{schema:expandSchema})
 const before=old.serialize()
 expect(listPlatformDeclarations({view:'isolated',status:'pending'},db).total).toBe(1)
 expect(readPlatformFilterOptions({source:'declarations',view:'isolated'},db).statuses).toEqual([' pending ','pending'])
 expect(old.serialize()).toEqual(before);old.close()
 expect(finalizeApplyStored(f).queryReady).toBe(true)
 const t=new Database(f.target)
 expect(t.prepare("SELECT count(*) n FROM platform_apply_projection WHERE exact_status='pending'").get()).toEqual({n:1})
 expect(t.prepare("SELECT DISTINCT exact_status FROM platform_apply_projection WHERE exact_status IS NOT NULL AND trim(exact_status)<>'' ORDER BY exact_status COLLATE BINARY").all()).toEqual([{exact_status:' pending '},{exact_status:'pending'}]);t.close()
})

import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { platformApplyStoredProjection, platformApplyStoredObservation } from '../upgrade/frozen/apply-stored-schema'
it('matches explicit successor column registry to physical catalog and keeps ordinary expand unextended',()=>{
 const f=fixture();finalizeApplyStored(f);const t=new Database(f.target)
 for(const table of [platformApplyStoredProjection,platformApplyStoredObservation]) {
  const config=getTableConfig(table),columns=t.pragma(`table_info(${config.name})`) as {name:string,type:string}[]
  for(const c of config.columns)expect(columns.find(x=>x.name===c.name)?.type.toLowerCase()).toBe(c.getSQLType().toLowerCase())
 }
 expect(getTableConfig(expandSchema.platformApplyProjection).columns.some(c=>c.name==='exact_status')).toBe(false)
 expect(t.prepare("SELECT sql FROM sqlite_schema WHERE name='platform_business_observation'").get()).toEqual({sql:expect.stringContaining('DEFERRABLE INITIALLY DEFERRED')})
 t.close()
})
it('preserves unsafe SQLite sequence highwaters exactly as integer bytes without JS number rounding',()=>{
 const f=fixture()
 for(const file of [f.source,f.target]){const t=new Database(file);t.exec("UPDATE sqlite_sequence SET seq=9007199254740993 WHERE name='platform_apply_projection'");t.close()}
 expect(finalizeApplyStored(f).queryReady).toBe(true)
 const t=new Database(f.target)
 expect(t.prepare("SELECT typeof(seq) kind,cast(seq AS text) value FROM sqlite_sequence WHERE name='platform_apply_projection'").get()).toEqual({kind:'integer',value:'9007199254740993'});t.close()
})
it('reports unsafe historical INTEGER as uncaptured and retains its exact sealed source bytes',()=>{
 const f=fixture()
 for(const path of [f.source,f.target]) {
  const t=new Database(path)
  const triggers=t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_archive_value'").all() as {name:string,sql:string}[]
  for(const r of triggers)t.exec(`DROP TRIGGER "${r.name}"`)
  const rows=t.prepare("SELECT a.id,a.bytes FROM platform_archive_value a JOIN platform_observation_archive_ref r ON r.archive_id=a.id WHERE r.field='legacyRowSnapshot'").all() as {id:number,bytes:Buffer}[]
  for(const row of rows){
   const snapshot=JSON.parse(row.bytes.toString('utf8')) as {fields:{name:string,storageClass:string,hex:string}[]}
   const year=snapshot.fields.find(c=>c.name==='year')!;year.storageClass='integer';year.hex='39303037313939323534373430393933'
   const bytes=Buffer.from(JSON.stringify(snapshot));t.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?').run(bytes,bytes.length,createHash('sha256').update(bytes).digest('hex'),row.id)
  }
  for(const r of triggers)t.exec(r.sql)
  t.close()
 }
 const result=finalizeApplyStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(false)
 expect(result.recovery.every(r=>r.exactState==='uncaptured'&&r.reason?.includes('unsafe-integer-cell'))).toBe(true)
 const t=new Database(f.target);expect(t.prepare('SELECT exact_year FROM platform_apply_projection').all()).toEqual([{exact_year:null},{exact_year:null}]);t.close()
})
it('authenticates frozen legacy source alone without adding a missing sealed snapshot or relaxing runtime verification',()=>{
 const f=fixture(true)
 for(const path of [f.source,f.target]) {
  const t=new Database(path)
  const triggers=t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_observation_archive_ref'").all() as {name:string,sql:string}[]
  for(const r of triggers)t.exec(`DROP TRIGGER "${r.name}"`)
  t.exec("DELETE FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot'")
  for(const r of triggers)t.exec(r.sql)
  t.close()
 }
 const predecessor=new Database(f.source)
 expect(()=>verifyFingerprint(predecessor,{observationId:1,collectionId:1,relationAlias:1})).toThrow(/Legacy cells missing/)
 predecessor.close()
 expect(finalizeApplyStored(f).queryReady).toBe(true)
 const t=new Database(f.target)
 expect(()=>verifyFingerprint(t,{observationId:1,collectionId:1,relationAlias:1})).toThrow(/Legacy cells missing/)
 expect(t.prepare("SELECT count(*) n FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot'").get()).toEqual({n:0})
 expect(t.prepare('SELECT exact_status FROM platform_apply_projection ORDER BY observation_id').all()).toEqual([{exact_status:' pending '},{exact_status:'pending'}]);t.close()
})

import { verifyFingerprint } from '../upgrade/frozen/fingerprint-verifier'

import { linkSync } from 'node:fs'
import { rowSnapshot } from '../upgrade/observations'
it.each(['samepath','hardlink','copiedpredecessor'])('rejects %s legacy custody before target writes',kind=>{
 const f=fixture(true)
 const path=kind==='samepath'?f.source:f.source+'.legacy'
 if(kind==='hardlink')linkSync(f.source,path)
 if(kind==='copiedpredecessor')copyFileSync(f.source,path)
 const t=new Database(f.target),bytes=t.serialize();t.close()
 expect(()=>finalizeApplyStored({...f,legacySource:path})).toThrow(/Distinct|legacy|Legacy/)
 const after=new Database(f.target);expect(after.serialize()).toEqual(bytes);after.close()
})
it('rejects plain cells and forged custody tokens at the shared verifier',()=>{
 const f=fixture(true),t=new Database(f.source)
 for(const token of [rowSnapshot(t,'platform_relation','id',1),{path:f.legacySource,active:true,verified:true}]) {
  expect(()=>Reflect.apply(verifyFingerprint,null,[t,{observationId:1,collectionId:1,relationAlias:1},{offlineLegacyCells:token}])).toThrow()
 }
 t.close()
})

import {withFrozenSource} from '../upgrade/frozen-source'
import {withLegacyFingerprintCustody,legacyCustodyCells} from '../upgrade/legacy-fingerprint-custody'
it('rejects forged and expired custody and expired predecessor freezes without target writes',()=>{
 const f=fixture(true),t=new Database(f.target),before=t.serialize();t.close()
 const owner={observationId:1,collectionId:1,relationAlias:1}
 let saved:object={}
 withFrozenSource(f.source,p=>{
  expect(()=>verifyFingerprint(p.database,owner,{legacyCustody:{active:true}})).toThrow(/custody/)
  withLegacyFingerprintCustody(p,f.legacySource,token=>{
   saved=token
   expect(legacyCustodyCells(token,p.database,1).find(c=>c.name==='status')?.hex).toBe('2070656E64696E6720')
  })
  expect(()=>verifyFingerprint(p.database,owner,{legacyCustody:saved})).toThrow(/custody/)
 })
 let stale:Parameters<typeof finalizeApplyStored>[1]
 withFrozenSource(f.source,p=>{stale=p})
 expect(()=>finalizeApplyStored(f,stale)).toThrow()
 const after=new Database(f.target);expect(after.serialize()).toEqual(before);after.close()
})
it.each(['snapshot','schema','manifest'])('rejects original-source receipt %s provenance drift before writes',field=>{
 const f=fixture(true)
 for(const path of [f.source,f.target]) {
  const t=new Database(path)
  t.prepare(`UPDATE platform_migration_run SET source_${field==='snapshot'?'snapshot_sha256':field==='schema'?'schema_hash':'manifest_sha256'}=? WHERE transform_version='t05a-observation-v3'`).run('0'.repeat(64));t.close()
 }
 const t=new Database(f.target),before=t.serialize();t.close()
 expect(()=>finalizeApplyStored(f)).toThrow(/provenance binding/)
 const after=new Database(f.target);expect(after.serialize()).toEqual(before);after.close()
})
it.each(['finalized-successor','marker-downgraded-predecessor'])('refuses copied %s as legacy even during replay',kind=>{
 const f=fixture(true),copy=f.source+'.impostor'
 if(kind==='finalized-successor')finalizeApplyStored(f)
 copyFileSync(kind==='finalized-successor'?f.target:f.source,copy)
 if(kind==='marker-downgraded-predecessor'){const d=new Database(copy);d.pragma('user_version=0');d.close()}
 const t=new Database(f.target),before=t.serialize();t.close()
 expect(()=>finalizeApplyStored({...f,legacySource:copy})).toThrow(/legacy source/)
 const after=new Database(f.target);expect(after.serialize()).toEqual(before);after.close()
})
it('cannot certify target residual status with no trusted snapshot or independent legacy',()=>{
 const f=fixture(true)
 for(const path of [f.source,f.target]) {
  const t=new Database(path)
  const triggers=t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_observation_archive_ref'").all() as {name:string,sql:string}[]
  for(const r of triggers)t.exec(`DROP TRIGGER "${r.name}"`)
  t.exec("DELETE FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot'; UPDATE platform_relation SET status='  pending  ' WHERE id=1")
  for(const r of triggers)t.exec(r.sql)
  t.close()
 }
 const result=finalizeApplyStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(false)
 expect(result.recovery.map(r=>[r.exactState,r.origin,r.reason])).toEqual([['uncaptured',null,'missing-trusted-stored-cells'],['uncaptured',null,'missing-trusted-stored-cells']])
 const t=new Database(f.target)
 expect(t.prepare('SELECT exact_status,exact_stored_state FROM platform_apply_projection ORDER BY observation_id').all()).toEqual([{exact_status:null,exact_stored_state:'uncaptured'},{exact_status:null,exact_stored_state:'uncaptured'}]);t.close()
})

import {createOfflineSnapshot} from '../upgrade/offline-snapshot'
it('migrates a WAL-backed predecessor snapshot and replays with literal exact cells',async()=>{
 const f=fixture(),snapshot=f.source+'.backup'
 const original=new Database(f.source)
 original.pragma('journal_mode=WAL');original.pragma('wal_autocheckpoint=0')
 original.exec("INSERT INTO enterprise(id,name,name_norm) VALUES(999,'WAL committed enterprise','WAL committed enterprise')")
 expect(statSync(f.source+'-wal').size).toBeGreaterThan(0)
 await createOfflineSnapshot(f.source,snapshot)
 original.close()
 copyFileSync(snapshot,f.target)
 const before=readFileSync(snapshot),options={...f,source:snapshot}
 expect(finalizeApplyStored(options).queryReady).toBe(true)
 const t=new Database(f.target)
 expect(t.prepare('SELECT name_norm FROM enterprise WHERE id=999').get()).toEqual({name_norm:'WAL committed enterprise'})
 expect(t.prepare('SELECT exact_status,exact_title_raw,sql_fact_title FROM platform_apply_projection ORDER BY observation_id').all()).toEqual([
  {exact_status:' pending ',exact_title_raw:'X',sql_fact_title:'2'},
  {exact_status:'pending',exact_title_raw:'X',sql_fact_title:'1'},
 ])
 const targetBytes=t.serialize();t.close()
 expect(finalizeApplyStored(options).queryReady).toBe(true)
 expect(readFileSync(snapshot)).toEqual(before)
 const replay=new Database(f.target);expect(replay.serialize()).toEqual(targetBytes);replay.close()
})
it.each(['source','legacySource'] as const)('rejects missing fixed %s before target writes',field=>{
 const f=fixture(),before=readFileSync(f.target)
 expect(()=>finalizeApplyStored({...f,[field]:f[field]+'.missing'})).toThrow()
 expect(readFileSync(f.target)).toEqual(before)
})
it.each(['samepath','hardlink'])('rejects %s target identity before migration',kind=>{
 const f=fixture(),before=readFileSync(f.source),alias=f.source+'.alias'
 if(kind==='hardlink')linkSync(f.source,alias)
 expect(()=>finalizeApplyStored({...f,target:kind==='samepath'?f.source:alias})).toThrow(/Distinct/)
 expect(readFileSync(f.source)).toEqual(before)
})
