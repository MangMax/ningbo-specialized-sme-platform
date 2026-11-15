import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as schema from '../upgrade/legacy-schema'
import { ensurePlatformObservation } from '../upgrade/frozen/server/platform-business-record'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { processStoredInstalled } from '../upgrade/process-stored-catalog'
import { rowSnapshot, schemaHash } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from '../upgrade/projections'
import { installProcessStoredSchema } from '../upgrade/process-stored-schema'
import { writeProcessTarget } from '../upgrade/frozen/process-target-writer'
import { targetSchema } from '../upgrade/target-schema'
import { bootstrapFingerprint } from '../upgrade/frozen/fingerprint-bootstrap'
import { verifyFingerprint } from '../upgrade/frozen/fingerprint-verifier'

async function fixture(indexed=true,extra?:(source:Database.Database)=>void) {
  const f = await witnessReaderFixture(source => {
    source.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','Q','2,3','t','success','c');
    INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,uscc_raw,raw_fields,created_at) VALUES
    (1,1,1,' N ',' U ','{"rdjb":"2","rdjb":"3","cszt":"pending"}','c'),
    (2,1,2,' N ',' U ','{"rdjb":"1","rdjb":"3","cszt":"pending"}','c');`)
    const db = drizzle(source, { schema })
    if(indexed){ensurePlatformObservation(db, 1); ensurePlatformObservation(db, 2)}
    source.exec("UPDATE platform_relation SET title_raw='X',declare_kind='申请',year=2024,status=' pending ',batch=' B ',applied_at=' D ',award_batch_label=' Award ',province=' P ' WHERE query_id=1")
    source.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(2,'apply_list','A','2','t','success','c'),(3,'recognized_list','R','2','t','success','c');
    INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(3,2,1,'{"id":"A","rdjb":"2","year":2024}','c'),(4,3,1,'{"id":"R","rdjb":"2","whpc":"B"}','c');`)
    if(indexed){ensurePlatformObservation(db,3);ensurePlatformObservation(db,4)}
    extra?.(source)
  })
  f.close()
  const source = join(f.root, 'process-source.sqlite')
  copyFileSync(f.target, source)
  return { ...f, source, runId: 'process', predecessorRunId: 'witness' }
}

it('captures eight original process cells and independent SQL title without changing old receipts and replays exactly', async () => {
  const f = await fixture()
  const before = new Database(f.source, { readonly: true })
  const runs = before.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all()
  before.close()
  const result = finalizeProcessStored(f)
  expect(result.queryReady).toBe(true)
  const t = new Database(f.target)
  try {
    expect(t.pragma('user_version', { simple: true })).toBe(71610)
    expect(processStoredInstalled(t)).toBe(true)
    expect(t.prepare("SELECT * FROM platform_migration_run WHERE run_id<>'process' ORDER BY run_id").all()).toEqual(runs)
    expect(t.prepare('SELECT observation_id,exact_title_raw,exact_declare_kind,exact_year,exact_status,exact_batch,exact_applied_at,exact_award_batch_label,exact_province,sql_fact_title,stored_status FROM platform_business_projection WHERE observation_id IS NOT NULL ORDER BY observation_id').all()).toEqual([1,2].map(id=>({observation_id:id,exact_title_raw:'X',exact_declare_kind:'申请',exact_year:2024,exact_status:' pending ',exact_batch:' B ',exact_applied_at:' D ',exact_award_batch_label:' Award ',exact_province:' P ',sql_fact_title:id===1?'2':'1',stored_status:'pending'})))
    expect(rowSnapshot(t,'platform_business_projection','observation_id',1,['exact_status'])[0]).toEqual({name:'exact_status',storageClass:'text',hex:'2070656E64696E6720'})
    expect(t.pragma('foreign_key_check')).toEqual([])
  } finally { t.close() }
  expect(finalizeProcessStored(f)).toEqual(result)
})

it('recovers sealed snapshots without legacy source including not-indexed observations and distinguishes true NULL from uncaptured', async () => {
 const f=await fixture(false)
 const result=finalizeProcessStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(true)
 expect(result.recovery.map(r=>[r.origin,r.exactState,r.titleState])).toEqual([['sealed_snapshot','captured','captured'],['sealed_snapshot','captured','captured']])
 const t=new Database(f.target)
 try{expect(t.prepare('SELECT identity_state FROM platform_business_observation WHERE collection_id=1 ORDER BY id').all()).toEqual([{identity_state:'not_indexed'},{identity_state:'not_indexed'}]);expect(t.prepare('SELECT exact_batch FROM platform_business_projection WHERE observation_id=1').get()).toEqual({exact_batch:' B '})}finally{t.close()}
})

it('enforces FK ON transaction entry and represents all original affinity storage classes without claiming full-chain REAL support', async () => {
 const f=await fixture(),t=new Database(f.target)
 try{
  t.pragma('foreign_keys=OFF');const before=projectionManifest(t)
  expect(()=>installProcessStoredSchema(t)).toThrow(/foreign_keys/)
  expect(projectionManifest(t)).toBe(before)
  t.pragma('foreign_keys=ON');expect(()=>installProcessStoredSchema(t)).toThrow(/transaction/)
  t.exec('BEGIN');installProcessStoredSchema(t)
  const fields=['exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','exact_batch','exact_award_batch_label','exact_province']
  for(const [value,kind,hex] of [['NULL','null',''],["''",'text',''],["' '",'text','20'],["'2024'",'text','32303234'],['2024.5','text','323032342E35'],["'bad'",'text','626164'],["X'32303234'",'blob','32303234'],["X''",'blob',''],["CAST(X'610062' AS TEXT)",'text','610062'],["CAST(X'FF' AS TEXT)",'text','FF']] as const){
   t.exec(`UPDATE platform_business_projection SET ${fields.map(c=>`${c}=${value}`).join(',')},exact_stored_state='captured',exact_stored_rule='process-stored-cells-v1',exact_stored_origin='sealed_snapshot',exact_stored_reason=NULL WHERE observation_id=1`)
   const actual=rowSnapshot(t,'platform_business_projection','observation_id',1,fields)
   expect(actual.map(c=>c.hex)).toEqual(Array(8).fill(hex))
   expect(actual.map(c=>c.storageClass)).toEqual(fields.map(c=>c==='exact_year'&&value==="'2024'"?'integer':c==='exact_year'&&value==='2024.5'?'real':kind))
   if(value==='2024.5')expect(actual[3]).toEqual({name:'exact_year',storageClass:'real',hex,real64be:'409fa20000000000'})
  }
  t.exec('ROLLBACK');expect(projectionManifest(t)).toBe(before)
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})

it('blocks capture deletion replacement upsert cross-owner writes and uncaptured downgraded writer while retaining the global runtime guard', async () => {
 const f=await fixture();finalizeProcessStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
 try{
  const before=projectionManifest(t)
  for(const statement of [
   'DELETE FROM platform_business_projection WHERE observation_id=1',
   'UPDATE platform_business_projection SET exact_status=exact_status WHERE observation_id=1',
   'INSERT OR REPLACE INTO platform_business_projection SELECT * FROM platform_business_projection WHERE observation_id=1',
   'UPDATE OR REPLACE platform_business_projection SET observation_id=2 WHERE observation_id=1',
   'INSERT INTO platform_business_projection SELECT * FROM platform_business_projection WHERE observation_id=1 ON CONFLICT(id) DO UPDATE SET exact_status=excluded.exact_status',
   'DELETE FROM platform_business_observation WHERE id=1',
   'INSERT OR REPLACE INTO platform_business_observation SELECT * FROM platform_business_observation WHERE id=1',
   'UPDATE OR REPLACE platform_business_observation SET sequence_no=2 WHERE id=1',
   "UPDATE platform_business_observation SET process_exact_state='uncaptured' WHERE id=1",
  ]){expect(()=>t.exec(statement),statement).toThrow(/immutable|captured/);expect(projectionManifest(t)).toBe(before)}
  // A2 now authorizes the authenticated successor writer; A1's old refusal stays in its accepted SHA.
  t.exec('BEGIN')
  const written=writeProcessTarget(drizzle(t,{schema:targetSchema}),{collectionId:1,position:{sequenceNo:3,positionState:'unknown'},row:{sequenceNo:3,rawFields:{}},assignment:{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'A1'},basis:'test'}})
  expect(t.prepare('SELECT exact_stored_state FROM platform_business_projection WHERE observation_id=?').get(written.observationId)).toEqual({exact_stored_state:'captured'})
  t.exec('ROLLBACK')
  expect(projectionManifest(t)).toBe(before)
  // Controlled marker downgrade demonstrates the SQL barrier independently of JS refusal.
  t.pragma('user_version=71609')
  expect(()=>writeProcessTarget(drizzle(t,{schema:targetSchema}),{collectionId:1,position:{sequenceNo:3,positionState:'unknown'},row:{sequenceNo:3,rawFields:{}},assignment:{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'A1'},basis:'test'}})).toThrow(/captured process/)
  t.pragma('user_version=71610');expect(projectionManifest(t)).toBe(before)
 }finally{t.close()}
})

it('rolls back populated DDL cell transfer barriers and receipts at every named failure stage', async () => {
 const f=await fixture(),source=new Database(f.source,{readonly:true})
 const before=projectionManifest(source),catalog=schemaHash(source);source.close()
 for(const stage of ['authenticated','dropped','created','copied:platform_business_observation','copied:platform_business_projection','restored','recovered','barrier','receipt']){
  expect(()=>finalizeProcessStored({...f,beforeCommit:s=>{if(s===stage)throw new Error('injected '+stage)}})).toThrow('injected '+stage)
  const t=new Database(f.target)
  try{expect(projectionManifest(t)).toBe(before);expect(schemaHash(t)).toBe(catalog);expect(t.pragma('user_version',{simple:true})).toBe(71609);expect(t.pragma('foreign_key_check')).toEqual([])}finally{t.close()}
 }
 expect(finalizeProcessStored(f).queryReady).toBe(true)
})

function rewriteSnapshot(t:Database.Database,mutate:(bytes:Buffer)=>Buffer){
 const triggers=t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_archive_value'").all() as {name:string,sql:string}[]
 for(const r of triggers)t.exec(`DROP TRIGGER "${r.name}"`)
 const a=t.prepare("SELECT a.id,a.bytes FROM platform_archive_value a JOIN platform_observation_archive_ref r ON r.archive_id=a.id WHERE r.owner_id=1 AND r.field='legacyRowSnapshot'").get() as {id:number,bytes:Buffer}
 const bytes=mutate(a.bytes);t.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?').run(bytes,bytes.length,createHash('sha256').update(bytes).digest('hex'),a.id)
 for(const r of triggers)t.exec(r.sql)
}

it('lists uncaptured invalid snapshot and rejects contradictory trusted snapshots before target writes', async () => {
 const f=await fixture()
 let t=new Database(f.source);rewriteSnapshot(t,()=>Buffer.from('invalid'));t.close();copyFileSync(f.source,f.target)
 const result=finalizeProcessStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(false)
 expect(result.recovery[0]).toMatchObject({observationId:1,exactState:'uncaptured',titleState:'captured',reason:'invalid-snapshot-encoding'})
 t=new Database(f.target);try{expect(t.prepare('SELECT exact_status,exact_stored_state,sql_fact_title FROM platform_business_projection WHERE observation_id=1').get()).toEqual({exact_status:null,exact_stored_state:'uncaptured',sql_fact_title:'2'})}finally{t.close()}
 const g=await fixture();t=new Database(g.source)
 rewriteSnapshot(t,bytes=>{const value=JSON.parse(bytes.toString());value.fields.find((c:{name:string})=>c.name==='status').hex='6F74686572';return Buffer.from(JSON.stringify(value))});t.close();copyFileSync(g.source,g.target)
 t=new Database(g.target);const before=projectionManifest(t);t.close()
 expect(()=>finalizeProcessStored(g)).toThrow(/source\/snapshot conflict/)
 t=new Database(g.target);try{expect(projectionManifest(t)).toBe(before);expect(t.pragma('user_version',{simple:true})).toBe(71609)}finally{t.close()}
})

function beginNewOwner(t:Database.Database) {
 // Existing assignment FKs are immediate; follow the accepted apply savepoint policy.
 t.exec('BEGIN; PRAGMA defer_foreign_keys=ON; SAVEPOINT nested')
 const bytes=Buffer.from('{}'),hash=createHash('sha256').update(bytes).digest('hex')
 t.prepare("INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256) VALUES(10000,'blob',?,2,?)").run(bytes,hash)
 t.exec("INSERT INTO platform_observation_fingerprint_basis VALUES(100,'target-command-v1',10000)")
 const columns=(t.pragma('table_info(platform_observation_assignment)') as {name:string}[]).map(c=>c.name)
 t.exec(`INSERT INTO platform_observation_assignment(${columns.join(',')}) SELECT ${columns.map(c=>c==='observation_id'?'100':c).join(',')} FROM platform_observation_assignment WHERE observation_id=1 AND revision=1`)
 t.exec("INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at,process_exact_owner_id,process_exact_state,process_sql_fact_title_state) VALUES(100,1,100,'unknown','not_indexed','not_indexed',NULL,100,'captured','captured')")
}
function newProjection(t:Database.Database,state:string,titleState:string){
 t.exec(`INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) SELECT 10001,storage_class,bytes,byte_length,sha256,created_at FROM platform_archive_value WHERE id=(SELECT source_archive_id FROM platform_business_projection WHERE observation_id=1);
 INSERT INTO platform_observation_archive_ref(owner_id,field,archive_id) VALUES(100,'rawFields',10001);
 UPDATE platform_observation_archive_ref SET sealed=1 WHERE owner_id=100;`)
 const cols=(t.pragma('table_info(platform_business_projection)') as {name:string}[]).map(c=>c.name)
 const overrides:Record<string,string>={id:'100',observation_id:'100',source_archive_id:'10001',exact_stored_state:`'${state}'`,sql_fact_title_state:`'${titleState}'`}
 if(state==='uncaptured'){
  for(const c of ['exact_status','exact_declare_kind','exact_year','exact_applied_at','exact_title_raw','exact_batch','exact_award_batch_label','exact_province','exact_stored_rule','exact_stored_origin'])overrides[c]='NULL'
  overrides.exact_stored_reason="'probe'"
 }
 if(titleState==='uncaptured')Object.assign(overrides,{sql_fact_title:'NULL',sql_fact_title_rule:'NULL',sql_fact_title_reason:"'probe'"})
 t.exec(`INSERT INTO platform_business_projection(${cols.join(',')}) SELECT ${cols.map(c=>overrides[c]??c).join(',')} FROM platform_business_projection WHERE observation_id=1`)
}
it('rejects missing projection and each uncaptured branch at outer COMMIT but permits the complete same-owner first capture', async () => {
 const f=await fixture();finalizeProcessStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
 try{
  const before=projectionManifest(t)
  for(const [state,titleState] of [['missing','missing'],['captured','uncaptured'],['uncaptured','captured'],['uncaptured','uncaptured']]){
   beginNewOwner(t)
   if(state!=='missing')newProjection(t,state!,titleState!)
   t.exec('RELEASE nested')
   expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);expect(t.inTransaction).toBe(true)
   t.exec('ROLLBACK');expect(projectionManifest(t)).toBe(before)
  }
  // This lower seam proves schema pairing/first INSERT, not A2 input authentication.
  beginNewOwner(t);newProjection(t,'captured','captured');t.exec('RELEASE nested; COMMIT')
  expect(t.prepare('SELECT process_exact_owner_id FROM platform_business_observation WHERE id=100').get()).toEqual({process_exact_owner_id:100})
  expect(t.pragma('foreign_key_check')).toEqual([])
 }finally{if(t.inTransaction)t.exec('ROLLBACK');t.close()}
})

it('reports unsafe original integer bytes as uncaptured without approximating them', async () => {
 const f=await fixture(false),t=new Database(f.source)
 rewriteSnapshot(t,bytes=>{const v=JSON.parse(bytes.toString());const year=v.fields.find((c:{name:string})=>c.name==='year');year.hex='39303037313939323534373430393933';return Buffer.from(JSON.stringify(v))});t.close();copyFileSync(f.source,f.target)
 const result=finalizeProcessStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(false)
 expect(result.recovery[0]).toMatchObject({exactState:'uncaptured',reason:expect.stringContaining('unsafe-integer-cell')})
 const target=new Database(f.target);try{expect(target.prepare('SELECT exact_year,exact_stored_state FROM platform_business_projection WHERE observation_id=1').get()).toEqual({exact_year:null,exact_stored_state:'uncaptured'})}finally{target.close()}
})

it('recovers authenticated preexisting process commands using true old materialization and leaves incompatible revision1 uncaptured', async () => {
 const f=await fixture(),t=new Database(f.source);t.pragma('foreign_keys=ON')
 const db=drizzle(t,{schema:targetSchema})
 const base={collectionId:1,position:{sequenceNo:3,positionState:'unknown' as const},row:{sequenceNo:3,status:' pending ',batch:' B ',appliedAt:' D ',declareKind:'申请' as const,year:2024,awardBatchLabel:' Award ',province:' P ',rawFields:{rdjb:' 2 ',cszt:'pending',whpc:'B',personuuid:'Award',szsfmc:'P',sblx:'申请',year:2024,sqsj:'D'}},assignment:{matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'A1'},basis:'test'}}
 const good=writeProcessTarget(db,base)
 const bad=writeProcessTarget(db,{...base,position:{sequenceNo:4,positionState:'unknown'},row:{...base.row,sequenceNo:4,nameRaw:' N '},assignment:{...base.assignment,nameRaw:' N '}})
 const exponent=writeProcessTarget(db,{...base,position:{sequenceNo:5,positionState:'unknown'},row:{sequenceNo:5,rawFields:{year:'2e3',rdjb:'2'}},assignment:base.assignment})
 const original=t.prepare('SELECT * FROM platform_observation_fingerprint_basis ORDER BY observation_id').all();t.close();copyFileSync(f.source,f.target)
 const result=finalizeProcessStored({...f,legacySource:undefined})
 expect(result.recovery.find(r=>r.observationId===good.observationId)).toMatchObject({origin:'command_materialized',exactState:'captured',materializationRule:'legacy-process-insert-v1'})
 expect(result.recovery.find(r=>r.observationId===bad.observationId)).toMatchObject({exactState:'uncaptured',reason:'command-materialization-revision1-or-key-incompatible'})
 const target=new Database(f.target)
 try{
  expect(target.prepare('SELECT exact_status,exact_batch,exact_applied_at,exact_declare_kind,exact_year,exact_award_batch_label,exact_province,exact_title_raw,sql_fact_title FROM platform_business_projection WHERE observation_id=?').get(good.observationId)).toEqual({exact_status:'pending',exact_batch:'B',exact_applied_at:'D',exact_declare_kind:'apply',exact_year:2024,exact_award_batch_label:'Award',exact_province:'P',exact_title_raw:'2',sql_fact_title:'2'})
  expect(target.prepare('SELECT * FROM platform_observation_fingerprint_basis ORDER BY observation_id').all()).toEqual(original)
  expect(target.prepare('SELECT exact_year,business_year FROM platform_business_projection WHERE observation_id=?').get(exponent.observationId)).toEqual({exact_year:2000,business_year:null})
 }finally{target.close()}
})

it('captures eight true SQL NULL cells separately from missing capture and authenticates a proven legacy-bootstrap lifecycle', async () => {
 const f=await fixture(false,source=>{
  source.exec("INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(5,1,99,'{}','c')")
 })
 let t=new Database(f.source);t.pragma('foreign_keys=ON')
 const owner={observationId:1,collectionId:1,relationAlias:1}
 expect(bootstrapFingerprint(t,owner,'ordinary')?.scheme).toBe('legacy-bootstrap-v1')
 t.close();copyFileSync(f.source,f.target)
 const result=finalizeProcessStored({...f,legacySource:undefined})
 expect(result.queryReady).toBe(true)
 expect(result.recovery.find(r=>r.observationId===5)).toMatchObject({exactState:'captured',titleState:'captured',title:null,reason:null})
 t=new Database(f.target)
 try{expect(t.prepare('SELECT exact_status,exact_declare_kind,exact_applied_at,exact_year,exact_title_raw,exact_batch,exact_award_batch_label,exact_province,exact_stored_state,sql_fact_title FROM platform_business_projection WHERE observation_id=5').get()).toEqual({exact_status:null,exact_declare_kind:null,exact_applied_at:null,exact_year:null,exact_title_raw:null,exact_batch:null,exact_award_batch_label:null,exact_province:null,exact_stored_state:'captured',sql_fact_title:null});expect(t.prepare('SELECT scheme FROM platform_observation_fingerprint_basis WHERE observation_id=1').get()).toEqual({scheme:'legacy-bootstrap-v1'})}finally{t.close()}
})

it('authenticates frozen original source alone without recreating missing sealed snapshots and refuses a different legacy artifact', async () => {
 const f=await fixture()
 const s=new Database(f.source)
 const triggers=s.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_observation_archive_ref'").all() as {name:string,sql:string}[]
 for(const r of triggers)s.exec(`DROP TRIGGER "${r.name}"`)
 s.exec("DELETE FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot' AND owner_id IN (1,2)")
 for(const r of triggers)s.exec(r.sql)
 s.close();copyFileSync(f.source,f.target)
 const before=new Database(f.source)
 expect(()=>verifyFingerprint(before,{observationId:1,collectionId:1,relationAlias:1})).toThrow(/Legacy cells missing/);before.close()
 const wrong=join(f.root,'wrong-legacy.sqlite');copyFileSync(f.legacySource,wrong)
 const w=new Database(wrong);w.exec("UPDATE platform_relation SET status='drift' WHERE id=1");w.close()
 const targetBefore=readFileSync(f.target)
 expect(()=>finalizeProcessStored({...f,legacySource:wrong})).toThrow(/provenance binding conflict/)
 expect(readFileSync(f.target)).toEqual(targetBefore)
 expect(finalizeProcessStored(f).queryReady).toBe(true)
 const t=new Database(f.target)
 try{expect(t.prepare("SELECT count(*) n FROM platform_observation_archive_ref WHERE field='legacyRowSnapshot' AND owner_id IN(1,2)").get()).toEqual({n:0});expect(t.prepare('SELECT exact_stored_origin FROM platform_business_projection WHERE observation_id=1').get()).toEqual({exact_stored_origin:'legacy_source'})}finally{t.close()}
})

it('executes the offline capture and fixed-source replay in fresh processes with exclusive evidence directories', async () => {
 const f=await fixture()
 for(const name of ['cli-first','cli-replay']){
  const evidence=join(f.root,name)
  const args=['upgrade/run-process-stored.mjs',f.source,f.target,evidence,'process','witness',f.legacySource]
  const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,JITI_FS_CACHE:'false'}})
  writeFileSync(join(f.root,name+'.log'),(result.stdout??'')+(result.stderr??''))
  expect(result.status,result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(evidence,'receipt.json'),'utf8'))).toMatchObject({state:'complete',queryReady:true})
 }
})

it.each([
  'DROP TRIGGER platform_process_stored_no_delete',
  'ALTER TABLE platform_business_projection RENAME COLUMN exact_status TO broken_exact_status',
  "DELETE FROM platform_migration_checkpoint WHERE run_id='process'",
  "UPDATE platform_migration_run SET target_schema_version='wrong' WHERE run_id='witness'",
  'PRAGMA user_version=71609',
])('offline replay authenticates catalog and receipt mutation %s',async sql=>{
 const f=await fixture();finalizeProcessStored(f)
 const target=join(f.root,'mutated.sqlite');copyFileSync(f.target,target)
 const t=new Database(target)
 try {t.exec(sql)} finally {t.close()}
 const before=readFileSync(target)
 expect(()=>finalizeProcessStored({...f,target})).toThrow()
 expect(readFileSync(target)).toEqual(before)
})

it('preserves BOM-prefixed raw TEXT SQL semantics through full migration and replay', async () => {
  const raw = '\ufeff{"rdjb":"2"}'
  const f = await fixture(false, source => source.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=1').run(raw))
  const old = new Database(f.legacySource, { readonly: true })
  try {
    expect(old.prepare("SELECT CASE WHEN json_valid(raw_fields) AND json_type(raw_fields,'$.rdjb')='text' THEN json_extract(raw_fields,'$.rdjb') ELSE NULL END title FROM platform_relation WHERE id=1").get()).toEqual({ title: null })
    expect(old.prepare('SELECT hex(CAST(raw_fields AS BLOB)) bytes FROM platform_relation WHERE id=1').get()).toEqual({ bytes: Buffer.from(raw).toString('hex').toUpperCase() })
  } finally { old.close() }
  expect(finalizeProcessStored(f).queryReady).toBe(true)
  const t = new Database(f.target, { readonly: true })
  try {
    expect(t.prepare('SELECT sql_fact_title,sql_fact_title_state FROM platform_business_projection WHERE observation_id=1').get()).toEqual({ sql_fact_title: null, sql_fact_title_state: 'captured' })
    expect(t.prepare("SELECT hex(a.bytes) bytes FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=1 AND r.field='rawFields'").get()).toEqual({ bytes: Buffer.from(raw).toString('hex').toUpperCase() })
  } finally { t.close() }
  const before = createHash('sha256').update(readFileSync(f.target)).digest('hex')
  expect(finalizeProcessStored(f).queryReady).toBe(true)
  expect(createHash('sha256').update(readFileSync(f.target)).digest('hex')).toBe(before)
})
