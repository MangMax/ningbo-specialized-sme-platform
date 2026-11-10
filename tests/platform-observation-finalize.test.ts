import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations } from '../upgrade/finalize-observations'

function fixture(seed?:(s:Database.Database)=>void) {
  const root=mkdtempSync(join(process.env.T05C_EVIDENCE_DIR??tmpdir(),'t05c-'))
  const source=join(root,'source.sqlite'),target=join(root,'target.sqlite'),s=new Database(source)
  migrate(drizzle(s),{migrationsFolder:'db/migrations'})
  s.exec(`insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(1,'apply_list','a','2','t','success','c'),(2,'business_list','b','3','t','success','c'),(3,'recognized_list','r','1','t','success','c');
    insert into platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) values(11,1,1,' A ',CAST(X'FF00' AS TEXT),'c'),(12,1,2,NULL,'{}','c'),(21,2,1,'','{}','c'),(31,3,1,' ','{}','c');`)
  seed?.(s)
  s.close();copyFileSync(source,target)
  upgradeCollections({source,target,runId:'t04',batchSize:2})
  upgradeObservations({source,target,runId:'t05a',collectionRunId:'t04',batchSize:2})
  upgradeProjections({source,target,runId:'t05b',observationRunId:'t05a',collectionRunId:'t04',batchSize:2})
  return {root,source,target,runId:'t05c',projectionRunId:'t05b',observationRunId:'t05a',collectionRunId:'t04'}
}
it('finalizes a populated three-source target preserving literal IDs unknowns bytes seals and all incoming owners',()=>{
  const f=fixture();expect(finalizeObservations(f).state).toBe('complete')
  const t=new Database(f.target)
  expect(t.prepare('select id,collection_id,sequence_no,source_relation_key,identity_state,indexed_at from platform_business_observation order by id').all()).toEqual([
    {id:11,collection_id:1,sequence_no:1,source_relation_key:' A ',identity_state:'not_indexed',indexed_at:null},
    {id:12,collection_id:1,sequence_no:2,source_relation_key:null,identity_state:'not_indexed',indexed_at:null},
    {id:21,collection_id:2,sequence_no:1,source_relation_key:'',identity_state:'not_indexed',indexed_at:null},
    {id:31,collection_id:3,sequence_no:1,source_relation_key:' ',identity_state:'not_indexed',indexed_at:null},
  ])
  expect(t.prepare('select sql from sqlite_schema where name=?').get('platform_business_observation')).not.toEqual(expect.objectContaining({sql:expect.stringContaining('relation_id')}))
  expect(t.prepare("select hex(a.bytes) bytes,r.sealed from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=11 and r.field='rawFields'").get()).toEqual({bytes:'FF00',sealed:1})
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
  expect(finalizeObservations(f).state).toBe('complete')
})

it('refuses finalized targets in current runtime and initialization before journal changes',async()=>{
  const {useRuntimeDb,initializeDb}=await import('../db/client')
  const f=fixture();finalizeObservations(f)
  for(const readOnly of [false,true])expect(()=>useRuntimeDb({dbPath:f.target,readOnly})).toThrow(/finalized/i)
  expect(()=>initializeDb({dbPath:f.target})).toThrow(/finalized/i)
  const t=new Database(f.target);expect(t.pragma('journal_mode',{simple:true})).toBe('delete');t.close()
})

import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { targetSchema as final } from '../upgrade/target-schema'
import * as archive from '../upgrade/target-archive'
import { finalizationCatalog,observationIncomingOwners } from '../upgrade/finalize-observations'

it.each(['dropped','created','copied:platform_observation_archive_ref','restored','receipt'])('atomically rolls back populated DDL and receipts at %s then restarts',stage=>{
  const f=fixture(),t=new Database(f.target),before=t.serialize();t.close()
  expect(()=>finalizeObservations({...f,beforeCommit:s=>{if(s===stage)throw new Error('injected DDL failure')}})).toThrow('injected DDL failure')
  const failed=new Database(f.target);expect(failed.serialize()).toEqual(before);expect(failed.prepare("select name from sqlite_temp_schema").all()).toEqual([]);failed.close()
  expect(finalizeObservations(f).state).toBe('complete')
})
it.each(['source','target','checkpoint','missing-phase','wrong-phase','wrong-source'])('refuses %s drift before any finalization',mode=>{
  const f=fixture(),t=new Database(mode==='source'?f.source:f.target)
  if(mode==='source')t.exec("update platform_relation set relation_key='drift' where id=11")
  if(mode==='target')t.exec("update platform_apply_projection set status='drift' where observation_id=11")
  if(mode==='checkpoint')t.exec("update platform_migration_checkpoint set batch_digest='drift' where phase='t05b-target'")
  if(mode==='missing-phase')t.exec("update platform_migration_run set state='running' where run_id='t05b'")
  t.close();const before=readFileSync(f.target)
  expect(()=>finalizeObservations({...f,...(mode==='wrong-phase'?{observationRunId:'other'}:{}),...(mode==='wrong-source'?{source:f.target}:{})})).toThrow()
  expect(readFileSync(f.target)).toEqual(before)
})
it('performs typed final target CRUD and archive alias ownership without old relation joins',()=>{
  const f=fixture();finalizeObservations(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const db=drizzle(t,{schema:final}),o=final.platformBusinessObservation
  db.insert(o).values({id:101,collectionId:1,sequenceNo:3,positionState:'unknown',identityState:'not_indexed',contentState:'not_indexed',indexedAt:null}).run()
  expect(db.select().from(o).where(eq(o.id,101)).get()).toMatchObject({id:101,indexedAt:null,sourceRelationKey:null})
  const id=archive.writeOwnerArchive(db,{kind:'observation',ownerId:101,field:'rawFields'},{storageClass:'blob',bytes:Buffer.from([0,255,1]),createdAt:null})
  archive.sealArchiveOwner(db,{kind:'observation',ownerId:101})
  archive.bindLegacyAlias(db,{kind:'relation',oldId:101,observationId:101})
  expect(archive.resolveLegacyReference(db,{version:1,kind:'relation',queryId:1,relationId:101})).toEqual({version:2,kind:'observation',observationId:101,collectionId:1})
  expect(archive.resolveLegacyReference(db,{version:1,kind:'relation',queryId:2,relationId:101})).toBeNull()
  expect(archive.readOwnerArchive(db,{kind:'observation',ownerId:101,field:'rawFields'})).toMatchObject({data:'AP8B',totalBytes:3})
  expect(()=>archive.bindArchive(db,{kind:'observation',ownerId:101,field:'sourceText',archiveId:id})).toThrow()
  expect(()=>db.update(final.platformObservationArchiveRef).set({sealed:0}).where(eq(final.platformObservationArchiveRef.ownerId,101)).run()).toThrow()
  expect(()=>db.insert(o).values({id:102,collectionId:1,sequenceNo:4,positionState:'unknown',identityState:'not_indexed',contentState:'not_indexed'}).run()).toThrow()
  expect(()=>archive.bindLegacyAlias(db,{kind:'relation',oldId:102,observationId:999})).toThrow()
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
it('preserves all incoming FK owners indexes triggers and physical target Drizzle constraints',()=>{
  const f=fixture(),before=new Database(f.target),catalog=finalizationCatalog(before)
  const snapshots=observationIncomingOwners.map(name=>({name,rows:before.prepare(`select * from ${name} order by rowid`).all()}))
  before.close();finalizeObservations(f)
  const t=new Database(f.target),after=finalizationCatalog(t)
  for(const {name,rows} of snapshots)expect(t.prepare(`select * from ${name} order by rowid`).all()).toEqual(rows)
  expect(after.filter(x=>x.type==='trigger').map(x=>x.name)).toEqual(catalog.filter(x=>x.type==='trigger').map(x=>x.name))
  expect(after.filter(x=>x.type==='index').map(x=>x.name)).toEqual(catalog.filter(x=>x.type==='index').map(x=>x.name))
  for(const table of [final.platformBusinessObservation,...observationIncomingOwners.map(name=>Object.values(final).find(v=>{try{return getTableConfig(v as typeof final.platformBusinessObservation).name===name}catch{return false}})!)]) {
    const config=getTableConfig(table as typeof final.platformBusinessObservation)
    const actual=t.pragma(`table_info(${config.name})`) as {name:string,notnull:number,pk:number}[]
    expect(actual.map(c=>c.name).sort()).toEqual(config.columns.map(c=>c.name).sort())
    for(const c of config.columns)expect(actual.find(a=>a.name===c.name)?.notnull).toBe(Number(c.notNull))
    const foreign=t.pragma(`foreign_key_list(${config.name})`) as {table:string,to:string,from:string}[]
    for(const fk of config.foreignKeys){const r=fk.reference();for(let i=0;i<r.columns.length;i++)expect(foreign).toContainEqual(expect.objectContaining({table:getTableConfig(r.foreignTable).name,from:r.columns[i]!.name,to:r.foreignColumns[i]!.name}))}
  }
  for(const name of observationIncomingOwners)expect((t.pragma(`foreign_key_list(${name})`) as {table:string,to:string}[]).filter(x=>x.table==='platform_business_observation').every(x=>x.to==='id')).toBe(true)
  expect(after.filter(x=>x.type==='view'&&x.sql.includes('platform_business_observation'))).toEqual([])
  expect(after.filter(x=>x.type==='trigger'&&x.name==='platform_legacy_relation_alias_owner')[0]!.sql).not.toMatch(/platform_relation|platform_query/)
  t.close()
})
it.each([0,1])('rejects NULL owner wrong page wrong source and REPLACE attacks with recursive triggers %i',recursive=>{
  const f=fixture();finalizeObservations(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');t.pragma(`recursive_triggers=${recursive}`)
  for(const query of [
    "insert into platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state) values(100,NULL,8,'unknown','not_indexed','not_indexed')",
    "insert into platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,page_id) values(100,1,8,'unknown','not_indexed','not_indexed',999)",
    "insert or replace into platform_business_observation select * from platform_business_observation where id=11",
    "insert or replace into platform_observation_archive_ref select * from platform_observation_archive_ref where owner_id=11",
    "insert or replace into platform_legacy_relation_alias select * from platform_legacy_relation_alias where old_id=11",
    "update platform_apply_projection set observation_id=21 where observation_id=11",
    "update platform_business_observation set collection_id=2 where id=11",
    "update platform_observation_assignment set revision=2 where observation_id=11",
  ])expect(()=>t.exec(query),query).toThrow()
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
it('replays finalized target without rewriting and refuses post-final source target ref and schema drift',()=>{
  const f=fixture();finalizeObservations(f);const before=readFileSync(f.target)
  finalizeObservations(f);expect(readFileSync(f.target)).toEqual(before)
  const t=new Database(f.target);t.exec("update platform_business_observation set source_relation_key='drift' where id=11");t.close()
  expect(()=>finalizeObservations(f)).toThrow(/drift/)
})
it('CLI emits raw source target FK trigger and receipt manifests then restarts in a new process',()=>{
  const f=fixture(),e=join(f.root,'cli');mkdirSync(e)
  const args=['upgrade/run-finalize-observations.mjs',f.source,f.target,e,f.runId,f.projectionRunId,f.observationRunId,f.collectionRunId]
  const run=spawnSync(process.execPath,args,{encoding:'utf8'});writeFileSync(join(e,'stdout.log'),run.stdout);writeFileSync(join(e,'stderr.log'),run.stderr)
  expect(run.status,run.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(e,'receipt.json'),'utf8')).state).toBe('complete')
  expect(readFileSync(join(e,'source-manifest.jsonl'),'utf8')).toContain('FF00')
  expect(readFileSync(join(e,'schema-manifest.json'),'utf8')).toContain('platform_observation_archive_ref')
  const next=join(f.root,'replay');mkdirSync(next);args[3]=next
  const replay=spawnSync(process.execPath,args,{encoding:'utf8'});expect(replay.status,replay.stderr).toBe(0)
  expect(readFileSync(join(e,'target-manifest.jsonl'))).toEqual(readFileSync(join(next,'target-manifest.jsonl')))
})

it('preserves indexed shared versions hashes sealed original refs aliases assignments and duplicate unknown pages',()=>{
  const f=fixture(s=>{
    s.exec(`update platform_query set collection_evidence='{"status":"success","pages":[{"rdjb":"2","page":1,"fetchedCount":1,"status":"success"},{"rdjb":"2","page":1,"fetchedCount":1,"status":"success"},{"page":3,"status":"failed"}]}' where id=1;
    insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(8,'apply_list','A','old','c');
    insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(9,8,'original','oldHash',' {"status":"旧"} ','vc');
    insert into platform_apply_projection(id,version_id,record_id,status,rule_version,created_at) values(77,9,8,'旧','old','pc');
    insert into platform_business_observation(relation_id,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) values(11,8,9,'resolved','verified','both','old','fp1','time'),(12,8,9,'resolved','verified','both','old','fp2','time');`)
  })
  const t=new Database(f.target),before=finalizationCatalog(t)
  const cells=t.prepare('select relation_id,record_id,version_id,key_source,projection_rule_version,input_fingerprint,indexed_at from platform_business_observation where record_id=8 order by relation_id').all()
  const versions=t.prepare('select * from platform_business_record_version').all(),pages=t.prepare('select * from platform_collection_page order by id').all()
  const raw=t.prepare('select * from platform_archive_value order by id').all(),refs=t.prepare('select * from platform_observation_archive_ref order by owner_id,field').all()
  t.close();finalizeObservations(f)
  const after=new Database(f.target)
  expect(after.prepare('select id as relation_id,record_id,version_id,key_source,projection_rule_version,input_fingerprint,indexed_at from platform_business_observation where record_id=8 order by id').all()).toEqual(cells)
  expect(after.prepare('select * from platform_business_record_version').all()).toEqual(versions)
  expect(after.prepare('select * from platform_collection_page order by id').all()).toEqual(pages)
  expect(pages).toHaveLength(3)
  expect(after.prepare('select * from platform_archive_value order by id').all()).toEqual(raw)
  expect(after.prepare('select * from platform_observation_archive_ref order by owner_id,field').all()).toEqual(refs)
  expect(after.prepare('select * from platform_apply_projection where version_id=9').get()).toMatchObject({id:77,status:'旧'})
  expect(finalizationCatalog(after).filter(x=>x.type==='table').map(x=>x.name)).toEqual(before.filter(x=>x.type==='table').map(x=>x.name))
  after.close()
})

it('matches empty final catalog to populated final catalog and rejects unsafe target identities',()=>{
  const populated=fixture(),empty=fixture(s=>s.exec('delete from platform_relation'))
  finalizeObservations(populated);finalizeObservations(empty)
  const p=new Database(populated.target),e=new Database(empty.target)
  expect(finalizationCatalog(e)).toEqual(finalizationCatalog(p))
  p.pragma('foreign_keys=ON')
  expect(()=>p.exec("insert into platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state) values(9007199254740992,1,100,'unknown','not_indexed','not_indexed')")).toThrow()
  p.close();e.close()
})
it('retains the frozen source lock throughout populated DDL and receipt stages',()=>{
  const f=fixture(),before=readFileSync(f.source),observed:string[]=[]
  finalizeObservations({...f,beforeCommit:stage=>{
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';const s=new Database(process.argv[1]);s.pragma('busy_timeout=1');try{s.exec("update platform_relation set relation_key='changed' where id=11");process.stdout.write('UNEXPECTED_WRITE')}catch(e){process.stdout.write(e.code)}finally{s.close()}`,f.source],{encoding:'utf8',timeout:5000})
    expect(result.stdout,result.stderr).toBe('SQLITE_BUSY');observed.push(stage)
  }})
  expect(observed).toContain('receipt');expect(observed).toContain('dropped');expect(readFileSync(f.source)).toEqual(before)
})
it('refuses finalized checkpoint metadata tampering',()=>{
  const f=fixture();finalizeObservations(f)
  const t=new Database(f.target);t.exec("update platform_migration_checkpoint set copied_count=99 where phase='t05c-final'");t.close()
  expect(()=>finalizeObservations(f)).toThrow(/drift/)
})
