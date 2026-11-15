import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../../../upgrade/collections'
import { upgradeObservations } from '../../../upgrade/observations'

function fixture(unindexed = false) {
  const root = mkdtempSync(join(process.env.T05A_EVIDENCE_DIR ?? tmpdir(), 't05a-'))
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  const s = new Database(source)
  migrate(drizzle(s), { migrationsFolder: 'db/migrations' })
  s.exec(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at,collection_evidence)
    values(7,'apply_list','q','2','qt','success','qc','{"pages":[{"page":3,"status":"success","fetchedCount":2}]}');
    insert into platform_relation(id,query_id,sequence_no,relation_key,raw_fields,source_text,name_raw,created_at)
    values(55,7,1,'  ','{"id":"different","year":false}',NULL,' 原名 ','rc'),(56,7,2,NULL,NULL,'','rc2','rc2');`)
  s.exec(`insert into platform_business_observation(relation_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at)
    values(55,'conflict','unverifiable','both','old-rule','old-fingerprint','old-indexed');`)
  if (!unindexed) s.exec(`insert into platform_business_observation(relation_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at)
    values(56,'missing_key','unverifiable','none','old-rule','other-fingerprint','old-indexed');`)
  s.close(); copyFileSync(source, target)
  upgradeCollections({ source,target,runId:'t04',batchSize:1 })
  return { root,source,target,runId:'t05a',collectionRunId:'t04',batchSize:1 }
}
it('maps observations and current assignment preserving original fields and bytes', () => {
  const f = fixture(), original = readFileSync(f.source)
  const s = new Database(f.source, {readonly:true})
  const old = s.prepare('select relation_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id,record_id,version_id from platform_business_observation order by relation_id').all()
  const bytes = s.prepare('select id,typeof(raw_fields) kind,cast(raw_fields as blob) bytes from platform_relation order by id').all()
  s.close()
  const result = upgradeObservations(f)
  expect(result.state).toBe('complete'); expect(result.copiedCount).toBe(2)
  const t = new Database(f.target)
  expect(t.prepare('select relation_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id,record_id,version_id from platform_business_observation order by relation_id').all()).toEqual(old)
  expect(t.prepare('select id,collection_id,sequence_no,page_row_no,position_state,source_relation_key from platform_business_observation order by id').all()).toEqual([
    {id:55,collection_id:7,sequence_no:1,page_row_no:1,position_state:'verified',source_relation_key:'  '},
    {id:56,collection_id:7,sequence_no:2,page_row_no:2,position_state:'verified',source_relation_key:null},
  ])
  expect(t.prepare('select observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,actor,recorded_at,command_receipt_id,origin from platform_observation_assignment order by observation_id').all()).toEqual([
    {observation_id:55,revision:1,enterprise_id:null,match_basis:'none',verification_status:'pending',name_raw:' 原名 ',actor:null,recorded_at:null,command_receipt_id:null,origin:'migrated_current'},
    {observation_id:56,revision:1,enterprise_id:null,match_basis:'none',verification_status:'pending',name_raw:'rc2',actor:null,recorded_at:null,command_receipt_id:null,origin:'migrated_current'},
  ])
  expect(t.prepare("select r.owner_id id,a.storage_class kind,a.bytes from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.field='rawFields' order by id").all()).toEqual(bytes)
  expect(t.prepare('select * from platform_legacy_relation_alias order by old_id').all()).toEqual([{old_id:55,observation_id:55},{old_id:56,observation_id:56}])
  expect(t.pragma('foreign_key_check')).toEqual([]); t.close()
  expect(readFileSync(f.source).equals(original)).toBe(true)
  expect(upgradeObservations({...f,transformVersion:'t05a-observation-v3'})).toEqual(result)
})

it('transfers an unindexed relation with genuine NULL indexing facts and exact source PK coverage', () => {
  const f=fixture(true), sourceBytes=readFileSync(f.source)
  const result=upgradeObservations(f)
  expect(result).toMatchObject({state:'complete',copiedCount:2,unresolved:[]})
  const t=new Database(f.target)
  expect(t.prepare('select relation_id,id,collection_id,sequence_no,page_row_no,position_state,source_relation_key,identity_state,content_state,record_id,version_id,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id from platform_business_observation where relation_id=56').get()).toEqual({relation_id:56,id:56,collection_id:7,sequence_no:2,page_row_no:2,position_state:'verified',source_relation_key:null,identity_state:'not_indexed',content_state:'not_indexed',record_id:null,version_id:null,key_source:null,projection_rule_version:null,input_fingerprint:null,indexed_at:null,batch_id:null})
  expect(t.prepare('select id from platform_business_observation order by id').all()).toEqual([{id:55},{id:56}])
  expect(t.prepare('select observation_id,revision,origin,actor,recorded_at,command_receipt_id from platform_observation_assignment where observation_id=56').get()).toEqual({observation_id:56,revision:1,origin:'migrated_current',actor:null,recorded_at:null,command_receipt_id:null})
  expect(t.prepare('select * from platform_legacy_relation_alias order by old_id').all()).toEqual([{old_id:55,observation_id:55},{old_id:56,observation_id:56}])
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
  expect(readFileSync(f.source).equals(sourceBytes)).toBe(true)
  expect(upgradeObservations(f)).toEqual(result)
})
it.each([false,true])('rolls back a whole batch and resumes with no duplicate archives or assignments (unindexed=%s)', (unindexed) => {
  const f=fixture(unindexed)
  expect(()=>upgradeObservations({...f,beforeCheckpoint:id=>{if(id===56) throw new Error('injected')}})).toThrow('injected')
  const t=new Database(f.target)
  expect(t.prepare("select last_old_id,copied_count from platform_migration_checkpoint where phase='observations'").all()).toEqual([{last_old_id:55,copied_count:1}])
  expect(t.prepare('select id from platform_business_observation where relation_id=56').get()).toEqual(unindexed?undefined:{id:null})
  expect(t.prepare('select observation_id from platform_observation_assignment').all()).toEqual([{observation_id:55}]);t.close()
  expect(upgradeObservations(f).copiedCount).toBe(2)
})
it('preserves complete sealed T02 bindings and matching existing aliases', () => {
  const f=fixture(),t=new Database(f.target),s=new Database(f.source)
  for(const id of [55,56]) {
    const columns=s.prepare('pragma table_info(platform_relation)').all() as {name:string}[]
    const fields=columns.map(({name})=>{
      const cell=s.prepare(`select typeof("${name}") storageClass,hex(cast("${name}" as blob)) hex from platform_relation where id=?`).get(id) as {storageClass:string,hex:string}
      return {name,...cell}
    })
    for(const field of ['rawFields','sourceText','legacyRowSnapshot']) {
      const cell=field==='legacyRowSnapshot'?{kind:'blob',bytes:Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields}))}:s.prepare(`select typeof(${field==='rawFields'?'raw_fields':'source_text'}) kind,cast(${field==='rawFields'?'raw_fields':'source_text'} as blob) bytes from platform_relation where id=?`).get(id) as {kind:string,bytes:Buffer|null}
      const hash=cell.bytes===null?null:createHash('sha256').update(cell.bytes).digest('hex')
      const a=t.prepare('insert into platform_archive_value(storage_class,bytes,byte_length,sha256) values(?,?,?,?)').run(cell.kind,cell.bytes,cell.bytes?.length??null,hash).lastInsertRowid
      t.prepare('insert into platform_observation_archive_ref(owner_id,field,archive_id) values(?,?,?)').run(id,field,a)
    }
    t.prepare('update platform_observation_archive_ref set sealed=1 where owner_id=?').run(id)
    t.prepare('insert into platform_legacy_relation_alias values(?,?)').run(id,id)
  }
  const before=t.prepare('select * from platform_observation_archive_ref order by owner_id,field').all();t.close();s.close()
  expect(upgradeObservations(f).state).toBe('complete')
  const after=new Database(f.target)
  expect(after.prepare('select * from platform_observation_archive_ref order by owner_id,field').all()).toEqual(before);after.close()
})

it.each(['source','observation','assignment','checkpoint','legacy','transform'] as const)('refuses drift for case %s', kind=>{
  const f=fixture();upgradeObservations(f)
  const db=new Database(kind==='source'?f.source:f.target)
  if(kind==='source') db.exec("update platform_relation set name_raw='changed' where id=55")
  if(kind==='observation') db.exec("update platform_business_observation set input_fingerprint='changed' where relation_id=55")
  if(kind==='assignment') {db.exec('drop trigger platform_assignment_no_update');db.exec("update platform_observation_assignment set name_raw='changed' where observation_id=55")}
  if(kind==='checkpoint') db.exec("update platform_migration_checkpoint set last_old_id=99 where phase='observations'")
  if(kind==='legacy') db.exec("update platform_relation set name_raw='changed' where id=55")
  db.close()
  expect(()=>upgradeObservations({...f,...(kind==='transform'?{transformVersion:'changed'}:{})})).toThrow(/drift|binding|differs/)
})
it('keeps unknown page positions and exact empty source keys',()=>{
  const f=fixture(),s=new Database(f.source),t=new Database(f.target)
  s.exec("update platform_query set collection_evidence=NULL where id=7; update platform_relation set relation_key='' where id=55")
  s.close();t.close();copyFileSync(f.source,f.target)
  upgradeCollections({...f,runId:'t04'})
  expect(upgradeObservations(f).state).toBe('complete')
  const result=new Database(f.target)
  expect(result.prepare('select page_id,page_row_no,position_state,source_relation_key from platform_business_observation where relation_id=55').get()).toEqual({page_id:null,page_row_no:null,position_state:'unknown',source_relation_key:''});result.close()
})
it('refuses unsafe identities and reports dangling owners without writes',()=>{
  const f=fixture(),s=new Database(f.source)
  s.exec('PRAGMA foreign_keys=OFF; update platform_relation set enterprise_id=987 where id=55');s.close()
  const before=readFileSync(f.target),result=upgradeObservations(f)
  expect(result.state).toBe('blocked');expect(result.unresolved).toEqual([{kind:'source_foreign_key',oldId:55,reason:'platform_relation -> enterprise'}]);expect(readFileSync(f.target).equals(before)).toBe(true)
  const g=fixture(),x=new Database(g.source)
  x.exec('PRAGMA foreign_keys=OFF; update platform_relation set id=0 where id=55');x.close()
  expect(()=>upgradeObservations(g)).toThrow('Unsafe source identity')
})
it('keeps shared verified versions with distinct observations and all original hashes',()=>{
  const f=fixture(),s=new Database(f.source)
  s.exec(`insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(9,'apply_list','key','identity-old','created-old');
    insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(10,9,'old-hash','immutable-hash','{"id":"key"}','version-time');
    update platform_business_observation set record_id=9,version_id=10,identity_state='resolved',content_state='verified';`)
  const old=s.prepare('select * from platform_business_record_version').all();s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  expect(upgradeObservations(f).copiedCount).toBe(2)
  const t=new Database(f.target)
  expect(t.prepare('select id,record_id,version_id from platform_business_observation order by id').all()).toEqual([{id:55,record_id:9,version_id:10},{id:56,record_id:9,version_id:10}])
  expect(t.prepare('select * from platform_business_record_version').all()).toEqual(old);t.close()
})
it.each(['blob','invalid-text','empty-text'] as const)('archives original SQLite bytes for case %s',kind=>{
  const f=fixture(),s=new Database(f.source)
  if(kind==='blob') s.prepare('update platform_relation set raw_fields=?,source_text=? where id=55').run(Buffer.from([255,0,1]),Buffer.from([0,255]))
  else if(kind==='invalid-text') s.exec("update platform_relation set raw_fields=cast(x'ff007b' as text),source_text=cast(x'ff' as text) where id=55")
  else s.exec("update platform_relation set raw_fields='',source_text='' where id=55")
  const expected=s.prepare('select typeof(raw_fields) storage_class,cast(raw_fields as blob) bytes from platform_relation where id=55').get()
  expect(()=>s.prepare('select json(raw_fields) from platform_relation where id=55').get()).toThrow('malformed JSON')
  s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  expect(upgradeObservations(f).state).toBe('complete')
  const t=new Database(f.target)
  expect(t.prepare("select a.storage_class,a.bytes from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=55 and r.field='rawFields'").get()).toEqual(expected)
  const snapshot=t.prepare("select a.bytes from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=55 and r.field='legacyRowSnapshot'").get() as {bytes:Buffer}
  const cells=JSON.parse(snapshot.bytes.toString()).fields as {name:string,storageClass:string,hex:string}[]
  const raw=cells.find(c=>c.name==='raw_fields')!
  expect({storage_class:raw.storageClass,bytes:Buffer.from(raw.hex,'hex')}).toEqual(expected);t.close()
})
it.each([false,true])('holds the source lock against a separate process through library checkpoint commit (unindexed=%s)',(unindexed)=>{
  const f=fixture(unindexed)
  expect(upgradeObservations({...f,beforeCheckpoint:()=>{
    const probe=spawnSync(process.execPath,['-e',`const D=require(${JSON.stringify(join(process.cwd(),'node_modules/better-sqlite3'))}); const d=new D(process.argv[1],{timeout:0}); for(const sql of ["update platform_relation set name_raw='external'",'pragma journal_mode=WAL']){try{d.exec(sql);process.exitCode=2}catch(e){if(e.code!=='SQLITE_BUSY')throw e}}d.close()`,f.source],{encoding:'utf8'})
    expect(probe.status).toBe(0);expect(probe.stderr).toBe('')
  }}).state).toBe('complete')
  const released=new Database(f.source,{timeout:0});expect(()=>released.exec("update platform_relation set name_raw='released'")).not.toThrow();released.close()
})
it('restores the full old SQLite row and independently reproduces the legacy DTO order',()=>{
  const f=fixture(),s=new Database(f.source)
  s.exec('update platform_relation set year=1.2345678901234567 where id=55');copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  const dto=`json_object('id',id,'queryId',query_id,'sequenceNo',sequence_no,'relationKey',relation_key,'enterpriseId',enterprise_id,'rawFields',json(raw_fields),'titleRaw',title_raw,'sourceText',source_text,'usccRaw',uscc_raw,'nameRaw',name_raw,'aliasNameRaw',alias_name_raw,'province',province,'status',status,'batch',batch,'declareKind',declare_kind,'appliedAt',applied_at,'awardBatchLabel',award_batch_label,'year',year,'matchBasis',match_basis,'verificationStatus',verification_status,'createdAt',created_at)`
  const expected=s.prepare(`select ${dto} dto from platform_relation order by id`).all()
  s.exec('create temp table restored as select * from platform_relation where 0')
  expect(upgradeObservations(f).state).toBe('complete')
  const t=new Database(f.target)
  const archives=t.prepare("select a.bytes from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.field='legacyRowSnapshot' order by r.owner_id").all() as {bytes:Buffer}[]
  for(const a of archives) {
    const row=JSON.parse(a.bytes.toString()) as {fields:{name:string,storageClass:string,hex:string,real64be?:string}[]}
    const values=row.fields.map(c=>c.storageClass==='null'?null:c.real64be?Buffer.from(c.real64be,'hex').readDoubleBE():Buffer.from(c.hex,'hex'))
    const expressions=row.fields.map(c=>c.storageClass==='null'||c.real64be?'?':c.storageClass==='blob'?'?':`cast(? as ${c.storageClass})`)
    s.prepare(`insert into restored values(${expressions.join(',')})`).run(...values)
  }
  expect(s.prepare(`select ${dto} dto from restored order by id`).all()).toEqual(expected)
  expect(s.prepare('select * from restored order by id').all()).toEqual(s.prepare('select * from platform_relation order by id').all());s.close();t.close()
})
it('captures confirmed current ownership without inventing an actor or confirmation time',()=>{
  const f=fixture(),s=new Database(f.source)
  s.exec("insert into enterprise(id,name,name_norm) values(9,'企业','企业');update platform_relation set enterprise_id=9,match_basis='manual',verification_status='confirmed',uscc_raw=' 原码 ',alias_name_raw=' 原别名 ' where id=55")
  s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  expect(upgradeObservations(f).state).toBe('complete')
  const t=new Database(f.target)
  expect(t.prepare('select enterprise_id,match_basis,verification_status,uscc_raw,alias_name_raw,actor,recorded_at,command_receipt_id from platform_observation_assignment where observation_id=55').get()).toEqual({enterprise_id:9,match_basis:'manual',verification_status:'confirmed',uscc_raw:' 原码 ',alias_name_raw:' 原别名 ',actor:null,recorded_at:null,command_receipt_id:null});t.close()
})
it('completes an empty source with exact zero PK coverage',()=>{
  const f=fixture(),s=new Database(f.source)
  s.exec('delete from platform_business_observation;delete from platform_relation;delete from platform_query');s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  const result=upgradeObservations(f)
  expect(result).toMatchObject({state:'complete',copiedCount:0,lastOldId:0,batchDigest:''})
  expect(upgradeObservations({...f,transformVersion:'t05a-observation-v3'})).toEqual(result)
})
it('preserves an exact existing revision1 and rejects a conflicting sealed archive atomically',()=>{
  const f=fixture(),t=new Database(f.target)
  t.exec("insert into platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,origin) values(55,1,NULL,'none','pending',' 原名 ','migrated_current')")
  const before=t.prepare('select * from platform_observation_assignment').get();t.close()
  expect(upgradeObservations(f).state).toBe('complete')
  const verified=new Database(f.target);expect(verified.prepare('select * from platform_observation_assignment where observation_id=55').get()).toEqual(before);verified.close()
  const g=fixture(),x=new Database(g.target)
  x.prepare('insert into platform_archive_value(storage_class,bytes,byte_length,sha256) values(?,?,?,?)').run('text',Buffer.from('different'),9,createHash('sha256').update('different').digest('hex'))
  const a=x.prepare('select max(id) id from platform_archive_value').get() as {id:number}
  x.prepare("insert into platform_observation_archive_ref(owner_id,field,archive_id,sealed) values(55,'rawFields',?,1)").run(a.id)
  x.close();expect(()=>upgradeObservations(g)).toThrow('Existing archive binding conflict')
  const check=new Database(g.target)
  expect(check.prepare('select id from platform_business_observation where relation_id=55').get()).toEqual({id:null})
  expect(check.prepare('select * from platform_observation_assignment').all()).toEqual([])
  expect(check.prepare("select * from platform_migration_checkpoint where phase='observations'").all()).toEqual([]);check.close()
})

it('independently covers every mixed indexed duplicate and unindexed source PK byte cell and target reference',()=>{
  const f=fixture(),s=new Database(f.source)
  s.exec(`insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(9,'apply_list','duplicate','old-rule','old-created');
    insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(10,9,'old-algorithm','old-hash','{}','old-version');
    update platform_business_observation set record_id=9,version_id=10,identity_state='resolved',content_state='verified';
    update platform_query set collection_evidence='{"pages":[{"page":3,"status":"success","fetchedCount":7}]}' where id=7;
    insert into platform_relation(id,query_id,sequence_no,relation_key,raw_fields,source_text,name_raw,created_at) values
    (57,7,3,NULL,NULL,NULL,' null ','legacy'),
    (58,7,4,'','','',' empty ','legacy'),
    (59,7,5,'  ',x'ff007b',x'00ff',' blob ','legacy'),
    (60,7,6,'duplicate',cast(x'ff007b' as text),cast(x'ff' as text),' invalid ','legacy'),
    (61,7,7,'duplicate','{"id":"other"}',' source ',' text ','legacy');`)
  // Independent original SQLite oracle: no migration manifest/snapshot/extractor generates expectations.
  const columns=s.prepare('pragma table_info(platform_relation)').all() as {name:string}[]
  const ids=(s.prepare('select id from platform_relation order by id').all() as {id:number}[]).map(x=>x.id)
  expect(ids).toEqual([55,56,57,58,59,60,61])
  const originals=s.prepare('select * from platform_business_observation order by relation_id').all()
  const versions=s.prepare('select * from platform_business_record_version order by id').all()
  const cells=new Map(ids.map(id=>[id,columns.map(({name})=>({name,...s.prepare(`select typeof("${name}") storageClass,hex(cast("${name}" as blob)) hex from platform_relation where id=?`).get(id) as {storageClass:string,hex:string}}))]))
  s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  const result=upgradeObservations({...f,batchSize:3})
  expect(result).toMatchObject({state:'complete',copiedCount:7,unresolved:[]})
  const t=new Database(f.target)
  expect(t.prepare('select relation_id,id from platform_business_observation order by id').all()).toEqual(ids.map(id=>({relation_id:id,id})))
  expect(t.prepare('select * from platform_business_record_version order by id').all()).toEqual(versions)
  for(const old of originals as Record<string,unknown>[]) {
    const now=t.prepare('select * from platform_business_observation where relation_id=?').get(old.relation_id) as Record<string,unknown>
    for(const field of ['relation_id','record_id','version_id','identity_state','content_state','key_source','projection_rule_version','input_fingerprint','indexed_at','batch_id']) expect(now[field]).toEqual(old[field])
  }
  for(const id of ids) {
    const expected=cells.get(id)!
    expect(t.prepare('select collection_id,sequence_no,page_row_no,position_state from platform_business_observation where id=?').get(id)).toEqual({collection_id:7,sequence_no:id-54,page_row_no:id-54,position_state:'verified'})
    const key=expected.find(c=>c.name==='relation_key')!
    expect(t.prepare('select typeof(source_relation_key) storageClass,hex(cast(source_relation_key as blob)) hex from platform_business_observation where id=?').get(id)).toEqual({storageClass:key.storageClass,hex:key.hex})
    const refs=t.prepare('select r.field,r.sealed,a.storage_class,a.bytes,a.sha256,a.created_at from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=? order by r.field').all(id) as {field:string,sealed:number,storage_class:string,bytes:Buffer|null,sha256:string|null,created_at:string|null}[]
    expect(refs.map(x=>x.field)).toEqual(['legacyRowSnapshot','rawFields','sourceText'])
    for(const ref of refs) {
      expect(ref.sealed).toBe(1);expect(ref.created_at).toBeNull()
      expect(ref.sha256).toBe(ref.bytes===null?null:createHash('sha256').update(ref.bytes).digest('hex'))
      if(ref.field==='legacyRowSnapshot') expect(JSON.parse(ref.bytes!.toString())).toEqual({encoding:'t05a-sqlite-cells-v1',fields:expected})
      else {const cell=expected.find(c=>c.name===(ref.field==='rawFields'?'raw_fields':'source_text'))!;expect(ref.storage_class).toBe(cell.storageClass);expect(ref.bytes).toEqual(cell.storageClass==='null'?null:Buffer.from(cell.hex,'hex'))}
    }
    expect(t.prepare('select * from platform_legacy_relation_alias where old_id=?').get(id)).toEqual({old_id:id,observation_id:id})
    expect(t.prepare('select revision,enterprise_id,match_basis,verification_status,origin,actor,basis,recorded_at,command_receipt_id from platform_observation_assignment where observation_id=?').all(id)).toEqual([{revision:1,enterprise_id:null,match_basis:'none',verification_status:'pending',origin:'migrated_current',actor:null,basis:null,recorded_at:null,command_receipt_id:null}])
    for(const column of ['name_raw','uscc_raw','alias_name_raw']) {const cell=expected.find(c=>c.name===column)!;expect(t.prepare(`select typeof(${column}) storageClass,hex(cast(${column} as blob)) hex from platform_observation_assignment where observation_id=?`).get(id)).toEqual({storageClass:cell.storageClass,hex:cell.hex})}
    if(id>=57) expect(t.prepare('select identity_state,content_state,record_id,version_id,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id from platform_business_observation where id=?').get(id)).toEqual({identity_state:'not_indexed',content_state:'not_indexed',record_id:null,version_id:null,key_source:null,projection_rule_version:null,input_fingerprint:null,indexed_at:null,batch_id:null})
  }
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
  expect(upgradeObservations({...f,batchSize:2})).toEqual(result)
})

it('rolls back inserted unindexed observations archives assignments aliases and checkpoint as one batch',()=>{
  const f=fixture(true)
  expect(()=>upgradeObservations({...f,batchSize:2,beforeCheckpoint:()=>{throw Error('batch-fault')}})).toThrow('batch-fault')
  const t=new Database(f.target)
  expect(t.prepare('select relation_id,id from platform_business_observation').all()).toEqual([{relation_id:55,id:null}])
  for(const table of ['platform_observation_assignment','platform_observation_archive_ref','platform_legacy_relation_alias']) expect(t.prepare(`select * from ${table}`).all()).toEqual([])
  expect(t.prepare("select * from platform_migration_checkpoint where phase='observations'").all()).toEqual([]);t.close()
  expect(upgradeObservations(f).copiedCount).toBe(2)
})

it.each(['mapping','metadata','lost','extra'] as const)('rejects generated unindexed target drift for case %s',kind=>{
  const f=fixture(true);upgradeObservations(f)
  const t=new Database(f.target)
  if(kind==='mapping') t.exec("update platform_business_observation set source_relation_key='invented' where relation_id=56")
  if(kind==='metadata') t.exec("update platform_business_observation set identity_state='missing_key',content_state='unverifiable',key_source='none',projection_rule_version='fake',input_fingerprint='fake',indexed_at='fake' where relation_id=56")
  if(kind==='lost') {t.pragma('foreign_keys=OFF');t.exec('delete from platform_business_observation where relation_id=56')}
  if(kind==='extra') {t.pragma('foreign_keys=OFF');t.exec("insert into platform_business_observation(relation_id,identity_state,content_state) values(99,'not_indexed','not_indexed')")}
  t.close();expect(()=>upgradeObservations(f)).toThrow(/drift|Missing|integrity/)
})

it('reports all true orphan source references even for unindexed relations without target writes',()=>{
  const f=fixture(true),s=new Database(f.source)
  s.pragma('foreign_keys=OFF');s.exec('update platform_relation set enterprise_id=987,query_id=999 where id=56');s.close()
  const before=readFileSync(f.target),result=upgradeObservations(f)
  expect(result.state).toBe('blocked')
  expect(result.unresolved.map(x=>x.reason).sort()).toEqual(['platform_relation -> enterprise','platform_relation -> platform_query'])
  expect(result.unresolved.every(x=>x.oldId===56)).toBe(true)
  expect(readFileSync(f.target).equals(before)).toBe(true)
})

it('keeps unknown page positions empty keys and confirmed ownership for unindexed history',()=>{
  const f=fixture(true),s=new Database(f.source)
  s.exec(`update platform_query set collection_evidence=NULL;
    insert into enterprise(id,name,name_norm) values(9,'企业','企业');
    update platform_relation set relation_key='',enterprise_id=9,match_basis='manual',verification_status='confirmed',uscc_raw=' 原码 ',alias_name_raw=' 原别名 ' where id=56;`)
  s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  expect(upgradeObservations(f).state).toBe('complete')
  const t=new Database(f.target)
  expect(t.prepare('select page_id,page_row_no,position_state,source_relation_key,indexed_at from platform_business_observation where id=56').get()).toEqual({page_id:null,page_row_no:null,position_state:'unknown',source_relation_key:'',indexed_at:null})
  expect(t.prepare('select enterprise_id,match_basis,verification_status,uscc_raw,alias_name_raw,actor,recorded_at,command_receipt_id from platform_observation_assignment where observation_id=56').get()).toEqual({enterprise_id:9,match_basis:'manual',verification_status:'confirmed',uscc_raw:' 原码 ',alias_name_raw:' 原别名 ',actor:null,recorded_at:null,command_receipt_id:null});t.close()
})

it('preserves a preexisting uncaptured observation without inventing metadata on replay',()=>{
  const f=fixture(true),s=new Database(f.source)
  s.exec("insert into platform_business_observation(relation_id,identity_state,content_state) values(56,'not_indexed','not_indexed')")
  const old=s.prepare('select record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id from platform_business_observation where relation_id=56').get()
  s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  const result=upgradeObservations(f),t=new Database(f.target)
  expect(t.prepare('select record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id from platform_business_observation where relation_id=56').get()).toEqual(old);t.close()
  expect(upgradeObservations(f)).toEqual(result)
})

it('transfers a wholly unindexed source and rejects old transform resumes',()=>{
  const f=fixture(true),s=new Database(f.source)
  s.exec('delete from platform_business_observation');s.close();copyFileSync(f.source,f.target);upgradeCollections({...f,runId:'t04'})
  const result=upgradeObservations(f),t=new Database(f.target)
  expect(result).toMatchObject({state:'complete',copiedCount:2,unresolved:[]})
  expect(t.prepare('select id,identity_state,content_state,indexed_at from platform_business_observation order by id').all()).toEqual([{id:55,identity_state:'not_indexed',content_state:'not_indexed',indexed_at:null},{id:56,identity_state:'not_indexed',content_state:'not_indexed',indexed_at:null}]);t.close()
  expect(upgradeObservations(f)).toEqual(result)
  for(const transformVersion of ['t05a-observation-v1','t05a-observation-v2']) expect(()=>upgradeObservations({...f,transformVersion})).toThrow('Source/schema/transform binding changed')
})

it.each(['control','sha256','created_at','archive_id','invalid_source_digest'] as const)('reconciles original sealed archive identity and metadata for %s', mutation => {
  const f=fixture(), s=new Database(f.source)
  const fields=(s.prepare('pragma table_info(platform_relation)').all() as {name:string}[]).map(({name})=>({name,...s.prepare(`select typeof("${name}") storageClass,hex(cast("${name}" as blob)) hex from platform_relation where id=55`).get() as object}))
  for(const [i,field] of ['rawFields','sourceText','legacyRowSnapshot'].entries()) {
    const cell=field==='legacyRowSnapshot'?{kind:'blob',bytes:Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields}))}:s.prepare(`select typeof(${field==='rawFields'?'raw_fields':'source_text'}) kind,cast(${field==='rawFields'?'raw_fields':'source_text'} as blob) bytes from platform_relation where id=55`).get() as {kind:string,bytes:Buffer|null}
    const sha=cell.bytes===null?null:createHash('sha256').update(cell.bytes).digest('hex')
    s.prepare('insert into platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) values(?,?,?,?,?,?)').run(91+i,cell.kind,cell.bytes,cell.bytes?.length??null,mutation==='invalid_source_digest'&&i===0?'0'.repeat(64):sha,'original-time')
    s.prepare('insert into platform_observation_archive_ref(owner_id,field,archive_id) values(55,?,?)').run(field,91+i)
  }
  s.exec('update platform_observation_archive_ref set sealed=1');s.close()
  copyFileSync(f.source,f.target);upgradeCollections({source:f.source,target:f.target,runId:'t04',batchSize:1})
  const t=new Database(f.target)
  const before=t.prepare('select r.*,a.* from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id order by r.field').all()
  if(mutation==='sha256'||mutation==='created_at') {
    const trigger=t.prepare("select sql from sqlite_schema where name='platform_archive_no_update'").get() as {sql:string}
    t.exec('drop trigger platform_archive_no_update')
    t.prepare(`update platform_archive_value set ${mutation}=? where id=91`).run(mutation==='sha256'?'0'.repeat(64):'invented-time')
    t.exec(trigger.sql)
  } else if(mutation==='archive_id') {
    const triggers=t.prepare("select name,sql from sqlite_schema where type='trigger' and tbl_name='platform_observation_archive_ref'").all() as {name:string,sql:string}[]
    for(const tr of triggers)t.exec(`drop trigger ${tr.name}`)
    t.exec('insert into platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) select 999,storage_class,bytes,byte_length,sha256,created_at from platform_archive_value where id=91;update platform_observation_archive_ref set archive_id=999 where archive_id=91')
    for(const tr of triggers)t.exec(tr.sql)
  }
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
  if(mutation==='control') {
    expect(upgradeObservations(f).state).toBe('complete');expect(upgradeObservations(f).state).toBe('complete')
    const result=new Database(f.target)
    expect(result.prepare('select r.*,a.* from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=55 order by r.field').all()).toEqual(before);result.close()
  } else {
    expect(()=>upgradeObservations(f)).toThrow(/archive/i)
    const result=new Database(f.target)
    expect(result.prepare("select * from platform_migration_run where run_id='t05a'").all()).toEqual([])
    expect(result.prepare('select * from platform_observation_assignment').all()).toEqual([])
    expect(result.prepare('select * from platform_legacy_relation_alias').all()).toEqual([])
    expect(result.prepare('select id from platform_business_observation where id is not null').all()).toEqual([]);result.close()
  }
})
