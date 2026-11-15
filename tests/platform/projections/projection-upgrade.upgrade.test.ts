import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { platformRowTitle } from '../../../lib/platform/row-title'
import { upgradeCollections } from '../../../upgrade/collections'
import { upgradeObservations } from '../../../upgrade/observations'
import { upgradeProjections } from '../../../upgrade/projections'

function fixture(seed?:(s:Database.Database)=>void) {
  const root=mkdtempSync(join(process.env.T05B_EVIDENCE_DIR??tmpdir(),'t05b-'))
  const source=join(root,'source.sqlite'),target=join(root,'target.sqlite'),s=new Database(source)
  migrate(drizzle(s),{migrationsFolder:'db/migrations'})
  s.exec(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(1,'apply_list','q','2,3','t','success','c'),(2,'business_list','q','2,3','t','success','c'),(3,'recognized_list','q','1,2','t','success','c');
    insert into platform_relation(id,query_id,sequence_no,relation_key,status,year,raw_fields,created_at) values
    (11,1,1,'A','退回',2020,'{"id":"B","rdjb":2,"cszt":"终审通过","year":" 2028 "}','c'),
    (12,1,2,'A','终审通过',NULL,'{"id":"C","rdjb":" 2 ","cszt":"终审通过","year":" 2028 "}','c'),
    (21,2,1,'A',NULL,NULL,'{"rdjb":true,"year":" 2028 ","cszt":" 通过 "}','c'),
    (31,3,1,'A',NULL,1999,'{"rdjb":false,"whpcyear":false,"whpc":" ","rddqrq":" 2028 "}','c');`)
  seed?.(s)
  s.close();copyFileSync(source,target)
  upgradeCollections({source,target,runId:'t04',batchSize:2})
  upgradeObservations({source,target,runId:'t05a',collectionRunId:'t04',batchSize:2})
  return {root,source,target,runId:'t05b',observationRunId:'t05a',collectionRunId:'t04',batchSize:2}
}
it('retains every observation and literal source parser versus process reconciliation fields',()=>{
  const f=fixture();expect(upgradeProjections(f).state).toBe('complete')
  const t=new Database(f.target)
  expect(t.prepare('select observation_id,source_title_kind,source_title_text,source_title_number_text,status,stored_status,parsed_status,reconciled_status,status_conflict,declaration_year,parsed_year,year_conflict from platform_apply_projection order by observation_id').all()).toEqual([
    {observation_id:11,source_title_kind:'number',source_title_text:null,source_title_number_text:'2',status:'终审通过',stored_status:'退回',parsed_status:'终审通过',reconciled_status:null,status_conflict:1,declaration_year:2028,parsed_year:2028,year_conflict:1},
    {observation_id:12,source_title_kind:'text',source_title_text:' 2 ',source_title_number_text:null,status:'终审通过',stored_status:'终审通过',parsed_status:'终审通过',reconciled_status:'终审通过',status_conflict:0,declaration_year:2028,parsed_year:2028,year_conflict:0},
  ])
  expect(t.prepare('select observation_id,source_title_kind,source_title_boolean,business_year,parsed_year,status from platform_business_projection').all()).toEqual([{observation_id:21,source_title_kind:'boolean',source_title_boolean:1,business_year:null,parsed_year:2028,status:'通过'}])
  expect(t.prepare('select observation_id,source_title_boolean,stored_year,parsed_year,reconciled_year,maintenance_year,source_maintenance_year_absent from platform_recognized_projection').all()).toEqual([{observation_id:31,source_title_boolean:0,stored_year:1999,parsed_year:null,reconciled_year:1999,maintenance_year:null,source_maintenance_year_absent:null}])
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
  expect(upgradeProjections(f).state).toBe('complete')
})

it('rejects checkpoint cursor tampering even when target rows are unchanged',()=>{
  const f=fixture();upgradeProjections(f)
  const t=new Database(f.target);t.exec("update platform_migration_checkpoint set last_old_id=11,copied_count=1 where phase='t05b-observations'");t.close()
  expect(()=>upgradeProjections(f)).toThrow(/drift/)
})

function shared(s:Database.Database) {
  s.exec(`insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(8,'apply_list','canonical','old-rule','c');
    insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(9,8,'legacy-hash','unchanged',' {"cszt":"终审通过"} ','vc');
    insert into platform_apply_projection(id,version_id,record_id,status,rule_version,created_at) values(77,9,8,'旧版本字段','old-projection','pc');
    insert into platform_business_observation(relation_id,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) values(11,8,9,'resolved','verified','both','old','fp1','time'),(12,8,9,'resolved','verified','both','old','fp2','time');`)
}
it('archives exact canonical bytes while preserving shared versions original fields hashes and distinct conflicts',()=>{
  const f=fixture(shared),s=new Database(f.source),t=new Database(f.target)
  const originals=s.prepare('select * from platform_apply_projection').all(),versions=s.prepare('select id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at from platform_business_record_version').all()
  s.close();t.close();upgradeProjections(f)
  const result=new Database(f.target)
  expect(result.prepare('select * from platform_apply_projection where version_id=9').all()).toEqual(originals)
  expect(result.prepare('select id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at from platform_business_record_version').all()).toEqual(versions)
  expect(result.prepare('select observation_id,status_conflict from platform_apply_projection where observation_id is not null order by observation_id').all()).toEqual([{observation_id:11,status_conflict:1},{observation_id:12,status_conflict:0}])
  expect(result.prepare("select v.canonical_archive_id=r.archive_id bound,r.sealed,a.storage_class,a.bytes from platform_business_record_version v join platform_version_archive_ref r on r.owner_id=v.id join platform_archive_value a on a.id=r.archive_id").all()).toEqual([{bound:1,sealed:1,storage_class:'text',bytes:Buffer.from(' {"cszt":"终审通过"} ')}])
  expect(result.prepare('select source_relation_key from platform_business_observation where relation_id in (11,12) order by relation_id').all()).toEqual([{source_relation_key:'A'},{source_relation_key:'A'}]);result.close()
})
it.each(['target','source','transform','checkpoint'] as const)('refuses completed replay drift for %s',kind=>{
  const f=fixture(shared);upgradeProjections(f)
  const t=new Database(kind==='source'?f.source:f.target)
  if(kind==='target')t.exec("update platform_apply_projection set status='tamper' where observation_id=11")
  if(kind==='source')t.exec("update platform_relation set name_raw='tamper' where id=11")
  if(kind==='checkpoint')t.exec("update platform_migration_checkpoint set batch_digest='tamper' where phase='t05b-observations'")
  t.close();expect(()=>upgradeProjections({...f,...(kind==='transform'?{transformVersion:'old'}:{})})).toThrow(/drift|binding/)
})
it('rolls back projections version refs and cursor within their failed batches and replays',()=>{
  const f=fixture(shared)
  expect(()=>upgradeProjections({...f,beforeCheckpoint:phase=>{if(phase==='observations')throw new Error('injected')}})).toThrow('injected')
  let t=new Database(f.target)
  expect(t.prepare('select observation_id from platform_apply_projection where observation_id is not null').all()).toEqual([]);t.close()
  expect(()=>upgradeProjections({...f,beforeCheckpoint:phase=>{if(phase==='versions')throw new Error('injected')}})).toThrow('injected')
  t=new Database(f.target)
  expect(t.prepare('select * from platform_version_archive_ref').all()).toEqual([])
  expect(t.prepare('select canonical_archive_id from platform_business_record_version').all()).toEqual([{canonical_archive_id:null}]);t.close()
  expect(upgradeProjections(f).state).toBe('complete');expect(upgradeProjections(f).state).toBe('complete')
})
it.each([
  ['null',null,'absent','absent',null,null,null],['empty','','invalid','invalid',null,null,null],
  ['bad','{','invalid','invalid',null,null,null],['json-null','null','invalid','invalid',null,null,null],
  ['array','[]','invalid','invalid',null,null,null],['object','{}','valid','absent',null,null,null],
  ['title-null','{"rdjb":null}','valid','null',null,null,null],['title-array','{"rdjb":[]}','valid','array',null,null,null],
  ['title-object','{"rdjb":{}}','valid','object',null,null,null],['unicode','{"rdjb":" 宁波 "}','valid','text',' 宁波 ',null,null],
  ['number','{"rdjb":2e0}','valid','number',null,'2',null],['true','{"rdjb":true}','valid','boolean',null,null,1],
  ['false','{"rdjb":false}','valid','boolean',null,null,0],['blob',Buffer.from('{"rdjb":2}'),'valid','number',null,'2',null],
  ['bad-utf8',Buffer.from([0xff]),'invalid','invalid',null,null,null],
] as const)('preserves raw bytes and title kind for %s',(_label,raw,state,kind,text,number,bool)=>{
  const f=fixture(s=>s.prepare('update platform_relation set raw_fields=? where id=11').run(raw))
  upgradeProjections(f);const t=new Database(f.target)
  expect(t.prepare('select parse_state,source_title_kind,source_title_text,source_title_number_text,source_title_boolean from platform_apply_projection where observation_id=11').get()).toEqual({parse_state:state,source_title_kind:kind,source_title_text:text,source_title_number_text:number,source_title_boolean:bool})
  const bytes=raw===null?null:Buffer.isBuffer(raw)?raw:Buffer.from(raw)
  expect(t.prepare("select a.bytes from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=11 and r.field='rawFields'").get()).toEqual({bytes});t.close()
})

function versionArchive(s:Database.Database,sealed=1) {
  shared(s)
  const bytes=Buffer.from(' {"cszt":"终审通过"} '),digest=createHash('sha256').update(bytes).digest('hex')
  s.prepare('insert into platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) values(501,?,?,?,?,?)').run('text',bytes,bytes.length,digest,'original-time')
  s.prepare("insert into platform_version_archive_ref(owner_id,field,archive_id,sealed) values(9,'canonicalRawJson',501,?)").run(sealed)
}
function hostile(s:Database.Database,table:string,change:()=>void) {
  const triggers=s.prepare("select name,sql from sqlite_schema where type='trigger' and tbl_name=?").all(table) as {name:string,sql:string}[]
  for(const t of triggers)s.exec(`drop trigger "${t.name}"`)
  try{change()}finally{for(const t of triggers)s.exec(t.sql)}
}
it.each(['control','sha256','created_at','archive_id','seal','missing','invalid_source'] as const)('validates source existing version archive identity metadata and digest for %s',mode=>{
  const f=fixture(s=>versionArchive(s)),t=new Database(mode==='invalid_source'?f.source:f.target)
  if(mode==='sha256'||mode==='invalid_source')hostile(t,'platform_archive_value',()=>t.exec("update platform_archive_value set sha256='"+'0'.repeat(64)+"' where id=501"))
  if(mode==='created_at')hostile(t,'platform_archive_value',()=>t.exec("update platform_archive_value set created_at='tamper' where id=501"))
  if(mode==='archive_id')hostile(t,'platform_version_archive_ref',()=>{
    t.exec('insert into platform_archive_value select 999,storage_class,bytes,byte_length,sha256,created_at from platform_archive_value where id=501')
    t.exec('update platform_version_archive_ref set archive_id=999 where owner_id=9')
  })
  if(mode==='seal')hostile(t,'platform_version_archive_ref',()=>t.exec('update platform_version_archive_ref set sealed=0 where owner_id=9'))
  if(mode==='missing')hostile(t,'platform_version_archive_ref',()=>t.exec('delete from platform_version_archive_ref where owner_id=9'))
  t.close()
  if(mode==='control') {
    expect(upgradeProjections(f).state).toBe('complete');expect(upgradeProjections(f).state).toBe('complete')
    const result=new Database(f.target)
    expect(result.prepare('select canonical_archive_id from platform_business_record_version').get()).toEqual({canonical_archive_id:501});result.close()
  } else {
    expect(()=>upgradeProjections(f)).toThrow(/archive|binding/)
    const result=new Database(f.target)
    expect(result.prepare("select * from platform_migration_run where run_id='t05b'").all()).toEqual([])
    expect(result.prepare('select observation_id from platform_apply_projection where observation_id is not null').all()).toEqual([]);result.close()
  }
})
it.each([null,0,1] as const)('preserves captured recognized fidelity marker %s without trimming or inventing maintenance year',marker=>{
  const f=fixture(s=>{
    s.exec(`insert into platform_business_record values(18,'recognized_list','r','old','c');
      insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(19,18,'old','h','{}','c');
      insert into platform_business_observation(relation_id,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) values(31,18,19,'resolved','verified','raw_id','old','fp','c');`)
    s.prepare("insert into platform_recognized_projection(version_id,record_id,source_validity_date,source_maintenance_batch,source_maintenance_year_absent,rule_version,created_at) values(19,18,' 2028 ',' ',?,'old','c')").run(marker)
  })
  upgradeProjections(f);const t=new Database(f.target)
  expect(t.prepare('select source_validity_date,source_maintenance_batch,source_maintenance_year_absent,stored_year,maintenance_year from platform_recognized_projection where observation_id=31').get()).toEqual({source_validity_date:' 2028 ',source_maintenance_batch:' ',source_maintenance_year_absent:marker,stored_year:1999,maintenance_year:null});t.close()
})
it('holds the frozen source against separate process UPDATE and WAL during both batch phases',()=>{
  const f=fixture(shared),before=readFileSync(f.source),probes:string[]=[]
  upgradeProjections({...f,beforeCheckpoint:phase=>{
    const code=`const D=require('better-sqlite3');const d=new D(process.argv[1],{timeout:0});for(const q of ["update platform_relation set status='changed' where id=11","pragma journal_mode=WAL"]){try{d.exec(q);process.stdout.write('UNLOCKED\\n')}catch(e){process.stdout.write(e.code+'\\n')}}d.close()`
    const result=spawnSync(process.execPath,['-e',code,f.source],{encoding:'utf8'})
    expect(result.status).toBe(0);expect(result.stdout.trim().split('\n')).toEqual(['SQLITE_BUSY','SQLITE_BUSY']);probes.push(phase)
  }})
  expect(new Set(probes)).toEqual(new Set(['observations','versions']));expect(readFileSync(f.source)).toEqual(before)
})
it('resumes in a fresh CLI process with identical persisted fields and emits full source target manifests',()=>{
  const f=fixture(s=>versionArchive(s,0)),oneShot=join(f.root,'oneshot.sqlite');copyFileSync(f.target,oneShot)
  upgradeProjections({...f,target:oneShot})
  expect(()=>upgradeProjections({...f,beforeCheckpoint:(phase,id)=>{if(phase==='observations'&&id===31)throw new Error('interrupt')}})).toThrow('interrupt')
  for(const suffix of ['restart','replay']) {
    const out=join(f.root,suffix);mkdirSync(out)
    const result=spawnSync(process.execPath,['upgrade/run-projections.mjs',f.source,f.target,out,f.runId,f.observationRunId,f.collectionRunId,'2'],{encoding:'utf8'})
    writeFileSync(join(out,'process.log'),result.stdout+result.stderr)
    expect(result.status).toBe(0);expect(JSON.parse(readFileSync(join(out,'receipt.json'),'utf8')).state).toBe('complete')
    expect(readFileSync(join(out,'source-manifest.jsonl'),'utf8')).toContain('canonical_raw_json')
    expect(readFileSync(join(out,'target-manifest.jsonl'),'utf8')).toContain('source_archive_id')
  }
  const a=new Database(oneShot),b=new Database(f.target)
  for(const table of ['platform_apply_projection','platform_business_projection','platform_recognized_projection','platform_archive_value','platform_version_archive_ref','platform_business_record_version'])expect(b.prepare(`select * from ${table} order by 1`).all()).toEqual(a.prepare(`select * from ${table} order by 1`).all())
  a.close();b.close()
})


it('pins all seven stored parsed and reconciled fields with independent literals',()=>{
  const f=fixture(s=>s.exec(`update platform_relation set province=' 浙江 ',status=' ',batch='旧批',declare_kind=' 申请 ',applied_at=NULL,award_batch_label=' 第四批 ',year=0,raw_fields='{"szsfmc":"浙江","cszt":"终审通过","whpc":"新批","sblx":"申请","sqsj":" 2028-01 ","personuuid":"第四批","year":"2.028e3"}' where id=11`))
  upgradeProjections(f);const t=new Database(f.target)
  expect(t.prepare(`select stored_province,parsed_province,reconciled_province,province_conflict,
    stored_status,parsed_status,reconciled_status,status_conflict,
    stored_batch,parsed_batch,reconciled_batch,batch_conflict,
    stored_declare_kind,parsed_declare_kind,reconciled_declare_kind,declare_kind_conflict,
    stored_applied_at,parsed_applied_at,reconciled_applied_at,applied_at_conflict,
    stored_award_batch_label,parsed_award_batch_label,reconciled_award_batch_label,award_batch_label_conflict,
    stored_year,parsed_year,reconciled_year,year_conflict,declaration_year from platform_apply_projection where observation_id=11`).get()).toEqual({
    stored_province:'浙江',parsed_province:'浙江',reconciled_province:'浙江',province_conflict:0,
    stored_status:null,parsed_status:'终审通过',reconciled_status:'终审通过',status_conflict:0,
    stored_batch:'旧批',parsed_batch:'新批',reconciled_batch:null,batch_conflict:1,
    stored_declare_kind:'apply',parsed_declare_kind:'apply',reconciled_declare_kind:'apply',declare_kind_conflict:0,
    stored_applied_at:null,parsed_applied_at:'2028-01',reconciled_applied_at:'2028-01',applied_at_conflict:0,
    stored_award_batch_label:'第四批',parsed_award_batch_label:'第四批',reconciled_award_batch_label:'第四批',award_batch_label_conflict:0,
    stored_year:0,parsed_year:2028,reconciled_year:null,year_conflict:1,declaration_year:null,
  });t.close()
})
it('covers every original PK and SQLite byte cell independently of the new manifests',()=>{
  const f=fixture(shared),s=new Database(f.source);upgradeProjections(f);const t=new Database(f.target)
  for(const table of ['platform_query','platform_relation','platform_business_record','platform_business_record_version','platform_apply_projection','platform_business_projection','platform_recognized_projection','platform_business_observation']) {
    const columns=s.prepare(`pragma table_info(${table})`).all() as {name:string,pk:number}[]
    const skip=table==='platform_business_record_version'?['canonical_archive_id']:table==='platform_business_observation'?['id','collection_id','sequence_no','page_id','page_row_no','position_state','source_relation_key']:[]
    const fields=columns.filter(x=>!skip.includes(x.name)),key=columns.find(c=>c.pk)!.name
    const projection=fields.flatMap(c=>[`typeof("${c.name}")`,`hex(cast("${c.name}" as blob))`]).join(',')
    const original=s.prepare(`select "${key}" id from ${table} order by "${key}"`).all() as {id:number}[]
    for(const {id} of original)expect(t.prepare(`select ${projection} from ${table} where "${key}"=?`).get(id)).toEqual(s.prepare(`select ${projection} from ${table} where "${key}"=?`).get(id))
  }
  expect(t.prepare('select observation_id id from platform_apply_projection where observation_id is not null union all select observation_id from platform_business_projection where observation_id is not null union all select observation_id from platform_recognized_projection where observation_id is not null order by id').all()).toEqual([{id:11},{id:12},{id:21},{id:31}])
  s.close();t.close()
})
it.each(['lost','extra','wrong-owner','legacy-version'] as const)('refuses target projection or reference alteration %s',mode=>{
  const f=fixture(shared);upgradeProjections(f);const t=new Database(f.target)
  if(mode==='lost')t.exec('delete from platform_apply_projection where observation_id=11')
  if(mode==='extra')t.exec("insert into platform_business_record values(99,'apply_list','extra','r','t')")
  if(mode==='wrong-owner')hostile(t,'platform_apply_projection',()=>t.exec('update platform_apply_projection set source_archive_id=(select source_archive_id from platform_apply_projection where observation_id=12) where observation_id=11'))
  if(mode==='legacy-version')t.exec("update platform_business_record_version set content_hash='changed' where id=9")
  t.close();expect(()=>upgradeProjections(f)).toThrow(/drift/)
})

it.each([
  ['number','{"rdjb":2}',2,'2'],['space','{"rdjb":" 2 "}',' 2 ',''],
  ['true','{"rdjb":true}',1,''],['false','{"rdjb":false}',0,''],
] as const)('retains distinct old SQLite and direct JS title inputs for %s',(_name,raw,sqlValue,jsTitle)=>{
  const f=fixture(s=>s.prepare('update platform_relation set raw_fields=? where id=11').run(raw));upgradeProjections(f)
  const s=new Database(f.source),t=new Database(f.target)
  expect(s.prepare("select json_extract(raw_fields,'$.rdjb') value from platform_relation where id=11").get()).toEqual({value:sqlValue})
  expect(platformRowTitle('1,2,3',JSON.parse(raw))).toBe(jsTitle)
  const row=t.prepare('select source_title_kind,source_title_text,source_title_number_text,source_title_boolean from platform_apply_projection where observation_id=11').get() as {source_title_kind:string,source_title_text:string|null,source_title_number_text:string|null,source_title_boolean:number|null}
  const sqliteInput=row.source_title_kind==='boolean'?row.source_title_boolean:row.source_title_kind==='number'?Number(row.source_title_number_text):row.source_title_text
  expect(sqliteInput).toBe(sqlValue);s.close();t.close()
})
it('completes an empty source without inventing projection or version owners',()=>{
  const f=fixture(s=>s.exec('delete from platform_relation;delete from platform_query'))
  expect(upgradeProjections(f)).toMatchObject({state:'complete',observationCount:0})
  expect(upgradeProjections(f)).toMatchObject({state:'complete',observationCount:0})
})
it.each(['matching','wrong-bytes','bad-digest'] as const)('validates target-only canonical archive for %s',mode=>{
  const f=fixture(shared),t=new Database(f.target),bytes=Buffer.from(mode==='wrong-bytes'?'{}':' {"cszt":"终审通过"} ')
  const digest=mode==='bad-digest'?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')
  t.prepare('insert into platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) values(801,?,?,?,?,NULL)').run('text',bytes,bytes.length,digest)
  t.exec("insert into platform_version_archive_ref(owner_id,field,archive_id,sealed) values(9,'canonicalRawJson',801,1)");t.close()
  if(mode==='matching')expect(upgradeProjections({...f,transformVersion:'t05b-source-projections-v1'}).state).toBe('complete')
  else {
    expect(()=>upgradeProjections(f)).toThrow(/digest|bytes conflict/)
    const result=new Database(f.target)
    expect(result.prepare('select canonical_archive_id from platform_business_record_version').get()).toEqual({canonical_archive_id:null})
    expect(result.prepare("select * from platform_migration_checkpoint where phase='t05b-versions'").all()).toEqual([]);result.close()
  }
})
it('archives BLOB canonical bytes without decoding invalid UTF8 or changing the legacy hash',()=>{
  const bytes=Buffer.from([0xff,0,0x20]),f=fixture(s=>{shared(s);s.prepare('update platform_business_record_version set canonical_raw_json=? where id=9').run(bytes)})
  upgradeProjections(f);const t=new Database(f.target)
  expect(t.prepare("select typeof(v.canonical_raw_json) kind,cast(v.canonical_raw_json as blob) original,v.content_hash,a.storage_class,a.bytes from platform_business_record_version v join platform_archive_value a on a.id=v.canonical_archive_id").get()).toEqual({kind:'blob',original:bytes,content_hash:'unchanged',storage_class:'blob',bytes});t.close()
})
it('retains indexed raw-only identity conflicts and both original relation keys',()=>{
  const f=fixture(s=>s.exec(`insert into platform_business_observation(relation_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) values(11,'conflict','unverifiable','both','old','fpB','old-time'),(12,'conflict','unverifiable','both','old','fpC','old-time')`))
  upgradeProjections(f);const t=new Database(f.target)
  expect(t.prepare('select relation_id,identity_state,content_state,source_relation_key,record_id,version_id,input_fingerprint from platform_business_observation where relation_id in (11,12) order by relation_id').all()).toEqual([
    {relation_id:11,identity_state:'conflict',content_state:'unverifiable',source_relation_key:'A',record_id:null,version_id:null,input_fingerprint:'fpB'},
    {relation_id:12,identity_state:'conflict',content_state:'unverifiable',source_relation_key:'A',record_id:null,version_id:null,input_fingerprint:'fpC'},
  ])
  expect(t.prepare('select observation_id,status_conflict,declaration_year from platform_apply_projection order by observation_id').all()).toEqual([{observation_id:11,status_conflict:1,declaration_year:2028},{observation_id:12,status_conflict:0,declaration_year:2028}]);t.close()
})
