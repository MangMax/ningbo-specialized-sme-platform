import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, copyFileSync, readFileSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'

function copyTarget(source: string, target: string) {
  copyFileSync(source,target); const t = new Database(target)
  try { migrate(drizzle(t), { migrationsFolder: 'db/migrations' }) } finally { t.close() }
}
function fixture() {
  const root = mkdtempSync(join(process.env.T04_EVIDENCE_DIR ?? tmpdir(), 't04-'))
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  const s = new Database(source)
  const old = join(root, 'migrations'); mkdirSync(old); mkdirSync(join(old,'meta'))
  for (const name of readdirSync('db/migrations').filter(n => n.endsWith('.sql') && Number(n.slice(0,4)) <= 50)) copyFileSync(join('db/migrations',name),join(old,name))
  const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'))
  writeFileSync(join(old,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.filter((e: {idx:number}) => e.idx <= 50)}))
  migrate(drizzle(s), { migrationsFolder: old })
  s.prepare(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) VALUES(7,'recognized_list','原键','2,3','原时间','failed',?,?, '原创建')`).run(Buffer.from([0,255]), '{titleScope:{rdjb:["2"," 3 ",2]},status:"auth_failed",pages:[{page:2,status:"success",fetchedCount:2},{page:2,status:"failed",fetchedCount:0},{page:2,status:"success",fetchedCount:0}],unfinished:[{page:3},{page:3}],effectiveConditions:{name:" 原名 ",whpc:false,sqsj:1.5,rddqrq:[],szq:null},error:{code:"auth_failed",message:"原失败"}}')
  s.prepare("insert into platform_relation(id,query_id,sequence_no,created_at) values(55,7,1,'original')").run()
  s.prepare("insert into platform_business_observation(relation_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) values(55,'missing_key','unverifiable','none','original','original','original')").run()
  s.close(); copyTarget(source, target)
  return { root, source, target, runId: 'fixture', batchSize: 1 }
}
it('moves collection facts and raw bytes with ordered pages without changing frozen legacy source', () => {
  const f = fixture(), before = readFileSync(f.source)
  const result = upgradeCollections(f)
  expect(result.copiedCount).toBe(1)
  expect(readFileSync(f.source)).toEqual(before)
  const t = new Database(f.target)
  expect(t.prepare('select id,status,evidence_status,queried_at,created_at,error_message from platform_collection').all()).toEqual([{ id:7,status:'failed',evidence_status:'auth_failed',queried_at:'原时间',created_at:'原创建',error_message:'原失败' }])
  expect(t.prepare('select ordinal,page_no,status,fetched_count,sequence_start,sequence_end from platform_collection_page order by ordinal').all()).toEqual([
    {ordinal:0,page_no:2,status:'success',fetched_count:2,sequence_start:1,sequence_end:2},
    {ordinal:1,page_no:2,status:'failed',fetched_count:0,sequence_start:null,sequence_end:null},
    {ordinal:2,page_no:2,status:'success',fetched_count:0,sequence_start:null,sequence_end:null},
  ])
  expect(t.prepare('select ordinal,page_no from platform_collection_unfinished order by ordinal').all()).toEqual([{ordinal:0,page_no:3},{ordinal:1,page_no:3}])
  expect(t.prepare('select rdjb,collection_id from platform_query_title_scope order by rdjb').all()).toEqual([{rdjb:' 3 ',collection_id:7},{rdjb:'2',collection_id:7}])
  expect(t.prepare("select storage_class,bytes from platform_archive_value a join platform_collection_archive_ref r on a.id=r.archive_id where r.field='rawResponse'").get()).toEqual({storage_class:'blob',bytes:Buffer.from([0,255])})
  expect(t.prepare('select * from platform_legacy_query_alias').all()).toEqual([{old_id:7,collection_id:7}])
  expect(t.prepare('select id,relation_id,collection_id,sequence_no from platform_business_observation').all()).toEqual([{id:null,relation_id:55,collection_id:null,sequence_no:null}])
  expect(t.prepare('select * from platform_observation_assignment').all()).toEqual([])
  expect(t.pragma('foreign_key_check')).toEqual([]); expect(t.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
  t.close()
  expect(upgradeCollections(f)).toEqual(result)
})

it('rolls back the entire failed batch and resumes from persistent source-bound checkpoints', () => {
  const f = fixture()
  let t = new Database(f.target)
  t.prepare(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(19,'apply_list','empty','','t','not_queried','c')`).run(); t.close()
  let s = new Database(f.source)
  s.prepare(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(19,'apply_list','empty','','t','not_queried','c')`).run(); s.close()
  expect(() => upgradeCollections({...f, beforeCheckpoint: key => { if(key === 19) throw new Error('injected') }})).toThrow('injected')
  t = new Database(f.target)
  expect(t.prepare('select id from platform_collection').all()).toEqual([{id:7}])
  expect(t.prepare('select last_old_id,copied_count from platform_migration_checkpoint').get()).toEqual({last_old_id:7,copied_count:1})
  expect(t.prepare('select old_id from platform_legacy_query_alias').all()).toEqual([{old_id:7}])
  expect(t.prepare('select count(*) n from platform_archive_value').get()).toEqual({n:2})
  t.close()
  const resumed = upgradeCollections(f)
  const once = join(f.root,'once.sqlite'); copyTarget(f.source, once)
  expect(upgradeCollections({...f,target:once,batchSize:2})).toEqual(resumed)
  expect(resumed.copiedCount).toBe(2)
})

it('refuses target tampering source schema bytes transform drift and aliased paths', () => {
  const f = fixture(); upgradeCollections(f)
  expect(() => upgradeCollections({...f, target:f.source})).toThrow('distinct')
  expect(() => upgradeCollections({...f, transformVersion:'future'})).toThrow('binding changed')
  const t = new Database(f.target)
  t.prepare("update platform_collection set evidence_status='invented'").run(); t.close()
  expect(() => upgradeCollections(f)).toThrow('drift')
  const g = fixture(); upgradeCollections(g)
  const s = new Database(g.source)
  s.exec('create table schema_drift(id integer)'); s.close()
  expect(() => upgradeCollections(g)).toThrow('binding changed')
  const h = fixture(); upgradeCollections(h)
  const changed = new Database(h.source)
  changed.prepare("update platform_query set raw_response='different'").run(); changed.close()
  expect(() => upgradeCollections(h)).toThrow('differs')
})

// Independent, frozen 0027 SQL, never a call to the upgrade extractor.
function oracle(s: Database.Database) {
  return {
    scopes: s.prepare(`SELECT DISTINCT q.id query_id, scope.value rdjb FROM platform_query q,
      json_each(CASE WHEN json_valid(q.collection_evidence,2) THEN CASE
      WHEN json_valid(json_extract(q.collection_evidence,'$.titleScope.rdjb'),2)
      THEN json_extract(q.collection_evidence,'$.titleScope.rdjb') ELSE 'null' END ELSE 'null' END) scope
      WHERE scope.type='text' ORDER BY query_id,rdjb`).all(),
    errors: s.prepare(`SELECT q.id query_id FROM platform_query q WHERE CASE
      WHEN q.collection_evidence IS NULL THEN 0 WHEN NOT json_valid(q.collection_evidence,2) THEN 1
      WHEN json_extract(q.collection_evidence,'$.titleScope.rdjb') IS NULL THEN 0
      WHEN NOT json_valid(json_extract(q.collection_evidence,'$.titleScope.rdjb'),2) THEN 1 ELSE 0 END=1 ORDER BY query_id`).all(),
  }
}
it('matches legacy JSON5 second-parse membership and error oracles across all interfaces and failure states', () => {
  const f = fixture(), s = new Database(f.source)
  const insert = s.prepare(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,raw_response,created_at) values(?,?,?,'2,3','original',?,?,?,'created')`)
  const archives = [null,'','{bad','{titleScope:{rdjb:"[\'2\',\' 3 \',2,true,null,]"}}','{titleScope:{rdjb:"not-json"}}','{titleScope:{rdjb:2}}','{titleScope:{rdjb:true}}','{titleScope:{rdjb:{a:"2"}}}','{titleScope:{rdjb:["2","3"]},effectiveConditions:{name:"",uscc:null,combination:true,sqsj:3.5,rddqrq:[],whpcyear:{a:1},whpc:4,szq:false,orderField:" 原 ",orderDirection:"desc"}}',Buffer.from([0xff,0,0x7b])]
  let key=20
  for (const source of ['business_list','apply_list','recognized_list']) for (const status of ['success','no_record','failed','not_queried','partial']) for (const archive of archives) insert.run(key++,source,String(key),status,archive, key%2===0 ? '' : null)
  const expected = oracle(s), original = s.prepare('select * from platform_query order by id').all()
  s.close(); copyTarget(f.source,f.target)
  expect(upgradeCollections({...f,batchSize:17}).copiedCount).toBe(151)
  const t = new Database(f.target)
  expect(t.prepare('select query_id,rdjb from platform_query_title_scope where collection_id=query_id order by query_id,rdjb').all()).toEqual(expected.scopes)
  expect(t.prepare('select query_id from platform_query_title_scope_error where collection_id=query_id order by query_id').all()).toEqual(expected.errors)
  expect(t.prepare('select * from platform_query order by id').all()).toEqual(original)
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual({n:151})
  expect(t.prepare('select value_kind,text_value,integer_value from platform_collection_condition where collection_id=28 order by name').all()).toEqual([
    {value_kind:'boolean',text_value:null,integer_value:1}, {value_kind:'text',text_value:'',integer_value:null},
    {value_kind:'text',text_value:'desc',integer_value:null}, {value_kind:'text',text_value:' 原 ',integer_value:null},
    {value_kind:'array',text_value:null,integer_value:null}, {value_kind:'real',text_value:null,integer_value:null},
    {value_kind:'boolean',text_value:null,integer_value:0}, {value_kind:'null',text_value:null,integer_value:null},
    {value_kind:'integer',text_value:null,integer_value:4}, {value_kind:'object',text_value:null,integer_value:null},
  ])
  expect(t.pragma('foreign_key_check')).toEqual([]); t.close()
})

it('archives complete supplement source fields without pretending they were captured collection evidence', () => {
  const f = fixture(), s = new Database(f.source)
  s.prepare(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,failure_reason,created_at) values(42,'business_list','supplement','2','original','partial','历史失败','created')`).run()
  s.prepare(`insert into import_batch(id,idempotency_key,source_kind,source_identity,created_at) values(1,'test','platform_archive','fixture','created')`).run()
  s.prepare(`insert into platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) values(42,? ,?,3,?,'old-fingerprint',1,'supp-created')`).run(' 原来源 ', 'a'.repeat(64), '{source:"businessList",pages:[{page:1,status:"success",fetchedCount:0}],limits:{maxRequests:4,pageSize:50},completeness:"partial"}')
  s.close(); copyTarget(f.source,f.target)
  upgradeCollections(f)
  const t = new Database(f.target)
  expect(t.prepare('select status,failure_reason,provenance_state,parse_state,source,max_requests,page_size from platform_collection where id=42').get()).toEqual({status:'partial',failure_reason:'历史失败',provenance_state:'legacy_supplement',parse_state:'valid',source:'businessList',max_requests:4,page_size:50})
  const blob = t.prepare("select bytes from platform_archive_value a join platform_collection_archive_ref r on r.archive_id=a.id where r.owner_id=42 and r.field='legacyProvenance'").get() as {bytes:Buffer}
  expect(blob.bytes.subarray(0,15).toString()).toBe('T04-PROVENANCE\n')
  expect(blob.bytes.includes(Buffer.from(' 原来源 '))).toBe(true)
  expect(blob.bytes.includes(Buffer.from('old-fingerprint'))).toBe(true)
  expect(blob.bytes.includes(Buffer.from('supp-created'))).toBe(true)
  expect(t.prepare('select collection_id from platform_query_title_scope where query_id=42').all()).toEqual([])
  t.close()
})

it('refuses archive and alias conflicts atomically and safe ID overflow without deleting old facts', () => {
  for (const conflict of ['archive','alias','unsafe']) {
    const f = fixture()
    const t = new Database(f.target)
    if (conflict === 'unsafe') {
      const s = new Database(f.source)
      for (const db of [s,t]) db.prepare(`insert into platform_query(id,interface,query_key,queried_at,created_at) values(9007199254740992,'apply_list','unsafe','t','c')`).run()
      s.close()
    } else if (conflict === 'archive') {
      t.exec(`create trigger inject_archive_conflict after insert on platform_collection begin insert into platform_archive_value(id,storage_class,bytes,byte_length,sha256) values(1,'null',null,null,null); insert into platform_collection_archive_ref(owner_id,field,archive_id,sealed) values(new.id,'rawResponse',1,1); end`)
    } else {
      t.exec(`create trigger inject_alias_conflict after insert on platform_collection begin insert into platform_legacy_query_alias(old_id,collection_id) values(7,new.id); end`)
    }
    t.close()
    expect(() => upgradeCollections(f)).toThrow()
    const result = new Database(f.target)
    expect(result.prepare('select * from platform_collection').all()).toEqual([])
    expect(result.prepare('select * from platform_migration_checkpoint').all()).toEqual([])
    expect(result.prepare('select * from platform_legacy_query_alias').all()).toEqual([])
    expect(result.prepare('select * from platform_archive_value').all()).toEqual([])
    expect(result.prepare('select id from platform_query where id=7').get()).toEqual({id:7})
    result.close()
  }
})

it('preserves TEXT bytes that are not valid UTF8 in original query metadata', () => {
  const f = fixture(), s = new Database(f.source)
  s.prepare("update platform_query set query_key=cast(x'FF0032' as text),last_collected_at='',failure_reason=cast(x'FE' as text) where id=7").run(); s.close()
  copyTarget(f.source,f.target); upgradeCollections(f)
  const t = new Database(f.target)
  expect(t.prepare('select typeof(query_key) kind,hex(cast(query_key as blob)) bytes,hex(cast(failure_reason as blob)) failure,last_collected_at from platform_collection').get()).toEqual({kind:'text',bytes:'FF0032',failure:'FE',last_collected_at:''})
  t.close()
})

it('reports inherited orphan provenance without fabricating a new collection owner', () => {
  const f=fixture(),s=new Database(f.source)
  s.pragma('foreign_keys=OFF')
  s.prepare(`insert into platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) values(999,'orphan','sha',0,'{bad','original',999,'original')`).run()
  s.close(); copyTarget(f.source,f.target)
  const result=upgradeCollections(f)
  expect(result.unresolved).toEqual([{kind:'orphan_provenance',oldQueryId:999,reason:'Original query owner missing; retained in isolated legacy copy and source manifest'}])
  const t=new Database(f.target)
  expect(t.prepare('select query_id from platform_query_legacy_provenance').all()).toEqual([{query_id:999}])
  expect(t.prepare('select old_id from platform_legacy_query_alias').all()).toEqual([{old_id:7}])
  t.close()
})

it('keeps missing invalid and contradictory page positions explicitly unknown and refuses active WAL input', () => {
  const f=fixture(),s=new Database(f.source)
  s.prepare('update platform_query set collection_evidence=? where id=7').run('{pages:[{page:0,status:"success",fetchedCount:1},{page:4,status:"success",fetchedCount:1},{page:5,status:"failed",fetchedCount:2},null]}')
  s.close();copyTarget(f.source,f.target);upgradeCollections(f)
  const t=new Database(f.target)
  expect(t.prepare('select ordinal,page_no,sequence_start,sequence_end,position_state from platform_collection_page order by ordinal').all()).toEqual([
    {ordinal:0,page_no:null,sequence_start:null,sequence_end:null,position_state:'unknown'},
    {ordinal:1,page_no:4,sequence_start:null,sequence_end:null,position_state:'unknown'},
    {ordinal:2,page_no:5,sequence_start:null,sequence_end:null,position_state:'unknown'},
    {ordinal:3,page_no:null,sequence_start:null,sequence_end:null,position_state:'unknown'},
  ]); t.close()
  const active = new Database(f.source)
  active.pragma('journal_mode=WAL'); active.prepare("update platform_query set failure_reason='active'").run()
  try { expect(() => upgradeCollections(f)).toThrow('WAL') } finally { active.close() }
})

it('rejects mixed nonpositive query and relation identities before any migration writes', () => {
  for (const table of ['platform_query', 'platform_relation']) {
    const f = fixture(), s = new Database(f.source)
    for (const bad of [-1, 0]) {
      if (table === 'platform_query') s.prepare("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(?,'recognized_list',?,'2','time','failed','time')").run(bad, String(bad))
      else s.prepare("insert into platform_relation(id,query_id,sequence_no,created_at) values(?,7,?,'time')").run(bad, bad + 3)
    }
    s.close(); copyTarget(f.source, f.target)
    expect(() => upgradeCollections(f)).toThrow(/Unsafe source identity/)
    const t = new Database(f.target)
    for (const name of ['platform_migration_run','platform_migration_checkpoint','platform_collection','platform_archive_value','platform_legacy_query_alias']) expect(t.prepare(`select count(*) n from ${name}`).get()).toEqual({ n: 0 })
    t.close()
  }
})

it('rejects persistent WAL without sidecars before a concurrent writer can commit', () => {
  const f = fixture(), s = new Database(f.source)
  s.pragma('journal_mode=WAL'); s.close(); copyTarget(f.source, f.target)
  let reached = false
  expect(() => upgradeCollections({ ...f, beforeCheckpoint() { reached = true } })).toThrow(/WAL/)
  expect(reached).toBe(false)
})

it('holds the rollback journal read lock against writes and WAL switches through checkpoints', () => {
  const f = fixture(), before = readFileSync(f.source)
  const result = upgradeCollections({ ...f, beforeCheckpoint() {
    const writer = new Database(f.source, { timeout: 0 })
    try {
      expect(() => writer.prepare("update platform_query set failure_reason='drift'").run()).toThrow(/locked/)
      expect(() => writer.pragma('journal_mode=WAL')).toThrow(/locked/)
    } finally { writer.close() }
  } })
  expect(result.copiedCount).toBe(1)
  expect(readFileSync(f.source)).toEqual(before)
})

it('CLI rejects invalid identities and persistent WAL before copying a target', () => {
  for (const mode of ['identity', 'wal']) {
    const f = fixture(), source = new Database(f.source)
    if (mode === 'wal') source.pragma('journal_mode=WAL')
    else source.prepare("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(0,'recognized_list','zero','2','time','failed','time')").run()
    source.close()
    const target = join(f.root, 'not-created.sqlite'), evidence = join(f.root, 'cli-evidence')
    mkdirSync(evidence)
    const result = spawnSync(process.execPath, ['upgrade/run.mjs', 'isolated-upgrade', f.source, target, evidence, 'cli-test'], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(mode === 'wal' ? /WAL/ : /Unsafe source identity/)
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(evidence)).toEqual([])
  }
})

it('CLI keeps a frozen source through copy and resumes in a separate process', () => {
  const f = fixture(), before = readFileSync(f.source), target = join(f.root, 'cli-target.sqlite')
  const receipts = []
  for (const attempt of ['first', 'resume']) {
    const evidence = join(f.root, attempt); mkdirSync(evidence)
    const result = spawnSync(process.execPath, ['upgrade/run.mjs', 'isolated-upgrade', f.source, target, evidence, 'cli-test', '1'], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    receipts.push(readFileSync(join(evidence, 'receipt.json'), 'utf8'))
  }
  expect(receipts[0]).toBe(receipts[1])
  expect(JSON.parse(receipts[0]!).copiedCount).toBe(1)
  expect(readFileSync(f.source)).toEqual(before)
})
