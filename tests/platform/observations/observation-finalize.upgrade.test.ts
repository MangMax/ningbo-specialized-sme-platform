import { compiledUpgradeCli } from '../runtime-boundary/fixtures/compiled-cli'
const cliArtifact = compiledUpgradeCli('finalize-observations-cli')
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { upgradeCollections } from '../../../upgrade/collections'
import { upgradeObservations } from '../../../upgrade/observations'
import { upgradeProjections } from '../../../upgrade/projections'
import { finalizeObservations } from '../../../upgrade/finalize-observations'

const roots: string[] = []
afterAll(() => { if (!process.env.T05C_EVIDENCE_DIR) for (const root of roots) rmSync(root, {recursive:true,force:true}) })
let pristine: ReturnType<typeof buildFixture> | undefined
function copyFixture<T extends ReturnType<typeof buildFixture>>(base: T): T {
  const root = mkdtempSync(join(process.env.T05C_EVIDENCE_DIR ?? tmpdir(), 't05c-'))
  roots.push(root)
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  copyFileSync(base.source, source); copyFileSync(base.target, target)
  return {...base, root, source, target}
}
function fixture(seed?:(s:Database.Database)=>void) {
  if (seed) return buildFixture(seed)
  pristine ??= buildFixture()
  return copyFixture(pristine)
}
function buildFixture(seed?:(s:Database.Database)=>void) {
  const root=mkdtempSync(join(process.env.T05C_EVIDENCE_DIR??tmpdir(),'t05c-'))
  roots.push(root)
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
  const {useRuntimeDb,initializeDb}=await import('../../../db/client')
  const f=fixture();finalizeObservations(f)
  for(const readOnly of [false,true])expect(()=>useRuntimeDb({dbPath:f.target,readOnly})).toThrow(/final platform runtime schema/i)
  expect(()=>initializeDb({dbPath:f.target})).toThrow(/final platform runtime schema/i)
  const t=new Database(f.target);expect(t.pragma('journal_mode',{simple:true})).toBe('delete');t.close()
})

import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { targetSchema as final } from '../../../upgrade/target-schema'
import * as archive from '../../../upgrade/target-archive'
import { finalizationCatalog,observationIncomingOwners } from '../../../upgrade/finalize-observations'

it.each(['dropped','created','copied:platform_observation_archive_ref','restored','receipt'])('atomically rolls back populated DDL and receipts at %s then restarts',stage=>{
  const f=fixture(),t=new Database(f.target),before=t.serialize();t.close()
  expect(()=>finalizeObservations({...f,beforeCommit:s=>{if(s===stage)throw new Error('injected DDL failure')}})).toThrow('injected DDL failure')
  const failed=new Database(f.target);expect(failed.serialize().equals(before), 'database bytes remain unchanged').toBe(true);expect(failed.prepare("select name from sqlite_temp_schema").all()).toEqual([]);failed.close()
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
  expect(readFileSync(f.target).equals(before)).toBe(true)
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
  const qualificationColumns=['source_recognized_at','source_valid_flag','source_invalidated_at','source_invalidation_reason','source_province_name','source_city_name','source_district_name','qualification_fields_rule']
  const addedColumns=(t:Database.Database)=>(t.pragma('table_info(platform_recognized_projection)') as {name:string;type:string;notnull:number;dflt_value:unknown;pk:number}[]).filter(c=>qualificationColumns.includes(c.name)).map(({name,type,notnull,dflt_value,pk})=>({name,type,notnull,dflt_value,pk})).sort((a,b)=>a.name.localeCompare(b.name))
  const addedBefore=addedColumns(before)
  expect(addedBefore).toEqual(qualificationColumns.map(name=>({name,type:name==='source_valid_flag'?'BLOB':'TEXT',notnull:0,dflt_value:null,pk:0})).sort((a,b)=>a.name.localeCompare(b.name)))
  const snapshots=observationIncomingOwners.map(name=>({name,rows:before.prepare(`select * from ${name} order by rowid`).all()}))
  before.close();finalizeObservations(f)
  const t=new Database(f.target),after=finalizationCatalog(t)
  expect(addedColumns(t)).toEqual(addedBefore)
  for(const {name,rows} of snapshots)expect(t.prepare(`select * from ${name} order by rowid`).all()).toEqual(rows)
  expect(after.filter(x=>x.type==='trigger').map(x=>x.name)).toEqual(catalog.filter(x=>x.type==='trigger').map(x=>x.name))
  expect(after.filter(x=>x.type==='index').map(x=>x.name)).toEqual(catalog.filter(x=>x.type==='index').map(x=>x.name))
  for(const table of [final.platformBusinessObservation,...observationIncomingOwners.map(name=>Object.values(final).find(v=>{try{return getTableConfig(v as typeof final.platformBusinessObservation).name===name}catch{return false}})!)]) {
    const config=getTableConfig(table as typeof final.platformBusinessObservation)
    const actual=t.pragma(`table_info(${config.name})`) as {name:string,notnull:number,pk:number}[]
    expect(actual.map(c=>c.name).sort()).toEqual([...config.columns.map(c=>c.name),...(config.name==='platform_recognized_projection'?qualificationColumns:[])].sort())
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
  finalizeObservations(f);expect(readFileSync(f.target).equals(before)).toBe(true)
  const t=new Database(f.target);t.exec("update platform_business_observation set source_relation_key='drift' where id=11");t.close()
  expect(()=>finalizeObservations(f)).toThrow(/drift/)
})
it('CLI emits raw source target FK trigger and receipt manifests',()=>{
  const f=fixture(),e=join(f.root,'cli');mkdirSync(e)
  const args=[cliArtifact(),f.source,f.target,e,f.runId,f.projectionRunId,f.observationRunId,f.collectionRunId]
  const run=spawnSync(process.execPath,args,{encoding:'utf8'});writeFileSync(join(e,'stdout.log'),run.stdout);writeFileSync(join(e,'stderr.log'),run.stderr)
  expect(run.status,run.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(e,'receipt.json'),'utf8')).state).toBe('complete')
  expect(readFileSync(join(e,'source-manifest.jsonl'),'utf8')).toContain('FF00')
  expect(readFileSync(join(e,'schema-manifest.json'),'utf8')).toContain('platform_observation_archive_ref')
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
  expect(observed).toContain('receipt');expect(observed).toContain('dropped');expect(readFileSync(f.source).equals(before)).toBe(true)
})

import { finalizeCollectionScopes } from '../../../upgrade/finalize-observations'
let pristineScope: ReturnType<typeof buildScopeFixture> | undefined
function scopeFixture() {
  pristineScope ??= buildScopeFixture()
  return copyFixture(pristineScope)
}
function buildScopeFixture() {
  const f=fixture(s=>{
    const values=[`{titleScope:{rdjb:['2','3','2',4,null,'','  ']}}`,JSON.stringify({titleScope:{rdjb:'["1","2"]'}}),'{bad',JSON.stringify({titleScope:{rdjb:'plain'}}),null,JSON.stringify({titleScope:{rdjb:'"2"'}}),JSON.stringify({titleScope:{rdjb:''}}),JSON.stringify({titleScope:{rdjb:'  '}}),null,null]
    for(let i=0;i<values.length;i++)s.prepare("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) values(?,'apply_list',?,'','t',?,?, 'c')").run(10+i,'scope'+i,i===4?'not_queried':i===8?'no_record':'failed',values[i])
  });finalizeObservations(f)
  return {...f,runId:'w4pre',finalizationRunId:f.runId}
}
it('finalizes collection scopes against frozen legacy SQL and complete PK byte oracle without changing other tables',()=>{
  const f=scopeFixture(),t=new Database(f.target)
  const rows=t.prepare('select collection_id,typeof(rdjb) kind,hex(cast(rdjb as blob)) bytes from platform_query_title_scope order by collection_id,rdjb').all()
  const errors=t.prepare('select collection_id from platform_query_title_scope_error order by collection_id').all()
  t.close()
  expect(finalizeCollectionScopes(f).state).toBe('complete')
  const a=new Database(f.target)
  expect(a.prepare('select collection_id,typeof(rdjb) kind,hex(cast(rdjb as blob)) bytes from platform_query_title_scope order by collection_id,rdjb').all()).toEqual(rows)
  expect(a.prepare('select collection_id from platform_query_title_scope_error order by collection_id').all()).toEqual(errors)
  expect(a.pragma('user_version',{simple:true})).toBe(71606)
  expect(a.pragma('foreign_key_check')).toEqual([]);a.close()
  const bytes=readFileSync(f.target);finalizeCollectionScopes(f);expect(readFileSync(f.target).equals(bytes)).toBe(true)
})

// Independent SQL oracle: frozen migration0027 expressions, no extractor/finalizer expectations.
function legacyScopeOracle(s:Database.Database) {
  return {
    scopes:s.prepare(`SELECT DISTINCT q.id collection_id,typeof(scope.value) kind,hex(cast(scope.value as blob)) bytes FROM platform_query q,json_each(CASE WHEN json_valid(q.collection_evidence,2) THEN CASE WHEN json_valid(json_extract(q.collection_evidence,'$.titleScope.rdjb'),2) THEN json_extract(q.collection_evidence,'$.titleScope.rdjb') ELSE 'null' END ELSE 'null' END) scope WHERE scope.type='text' ORDER BY q.id,scope.value`).all(),
    errors:s.prepare(`SELECT q.id collection_id FROM platform_query q WHERE CASE WHEN q.collection_evidence IS NULL THEN 0 WHEN NOT json_valid(q.collection_evidence,2) THEN 1 WHEN json_extract(q.collection_evidence,'$.titleScope.rdjb') IS NULL THEN 0 WHEN NOT json_valid(json_extract(q.collection_evidence,'$.titleScope.rdjb'),2) THEN 1 ELSE 0 END=1 ORDER BY q.id`).all(),
  }
}
// Full independent named-cell oracle, ordered by every physical PK (no production manifest).
function independentCells(t:Database.Database,excluded:string[]=[]) {
  const result:Record<string,unknown>={}
  for(const {name} of t.prepare("select name from sqlite_schema where type='table' and name not like 'sqlite_%' order by name").all() as {name:string}[]) {
    if(excluded.includes(name))continue
    const cols=t.pragma(`table_info("${name}")`) as {name:string,pk:number}[]
    const pk=cols.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>`"${c.name}"`).join(',')||'rowid'
    result[name]=t.prepare(`select ${cols.flatMap(c=>[`typeof("${c.name}") "${c.name}:type"`,`hex(cast("${c.name}" as blob)) "${c.name}:hex"`]).join(',')} from "${name}" order by ${pk}`).all()
  }
  return result
}
it('matches populated frozen migration0027 oracle and preserves every unrelated table cell and historical receipt',()=>{
  const f=scopeFixture(),s=new Database(f.source),t=new Database(f.target),oracle=legacyScopeOracle(s)
  expect(oracle.scopes).toEqual([{collection_id:10,kind:'text',bytes:''},{collection_id:10,kind:'text',bytes:'2020'},{collection_id:10,kind:'text',bytes:'32'},{collection_id:10,kind:'text',bytes:'33'},{collection_id:11,kind:'text',bytes:'31'},{collection_id:11,kind:'text',bytes:'32'},{collection_id:15,kind:'text',bytes:'32'}])
  expect(oracle.errors).toEqual([{collection_id:12},{collection_id:13},{collection_id:16},{collection_id:17}])
  const excluded=['platform_query_title_scope','platform_query_title_scope_error','platform_migration_run','platform_migration_checkpoint']
  const watermarks=t.prepare('select * from sqlite_sequence order by name').all()
  const before=independentCells(t,excluded),runs=t.prepare('select * from platform_migration_run order by run_id').all(),cp=t.prepare('select * from platform_migration_checkpoint order by run_id,phase,source_table').all(),catalog=finalizationCatalog(t)
  s.close();t.close();finalizeCollectionScopes(f)
  const a=new Database(f.target)
  expect(a.prepare('select collection_id,typeof(rdjb) kind,hex(cast(rdjb as blob)) bytes from platform_query_title_scope order by collection_id,rdjb').all()).toEqual(oracle.scopes)
  expect(a.prepare('select collection_id from platform_query_title_scope_error order by collection_id').all()).toEqual(oracle.errors)
  expect(independentCells(a,excluded)).toEqual(before)
  expect(a.prepare('select * from sqlite_sequence order by name').all()).toEqual(watermarks)
  expect(a.prepare("select * from platform_migration_run where run_id<>'w4pre' order by run_id").all()).toEqual(runs)
  expect(a.prepare("select * from platform_migration_checkpoint where run_id<>'w4pre' order by run_id,phase,source_table").all()).toEqual(cp)
  const unrelated=(c:ReturnType<typeof finalizationCatalog>)=>c.filter(x=>!x.name.startsWith('platform_query_title_scope')&&!x.tbl_name.startsWith('platform_query_title_scope'))
  expect(unrelated(finalizationCatalog(a))).toEqual(unrelated(catalog));a.close()
})
it.each(['dropped','created','copied','indexed','receipt'])('successor rolls back all DDL bytes triggers marker and receipt at %s then retries',stage=>{
  const f=scopeFixture(),before=readFileSync(f.target)
  expect(()=>finalizeCollectionScopes({...f,beforeCommit:s=>{if(s===stage)throw new Error('successor fault')}})).toThrow('successor fault')
  expect(readFileSync(f.target).equals(before)).toBe(true)
  expect(finalizeCollectionScopes(f).state).toBe('complete')
})
it.each(['source','fact','null-owner','wrong-owner','missing-alias','incoming','trigger','index','missing-t04','missing-t05a','missing-t05b','missing-t05c','wrong-run','inode'])('successor refuses %s before writing',mode=>{
  const f=scopeFixture(),t=new Database(mode==='source'?f.source:f.target)
  if(mode==='source')t.exec("update platform_query set query_key='changed' where id=1")
  if(mode==='fact')t.exec("update platform_query_title_scope set rdjb='changed' where query_id=10 and rdjb='2'")
  if(mode==='null-owner')t.exec('update platform_query_title_scope set collection_id=NULL where query_id=10')
  if(mode==='wrong-owner')t.exec('update platform_query_title_scope_error set collection_id=1 where query_id=12')

  if(mode==='missing-alias')t.exec('drop trigger platform_legacy_query_alias_no_delete; delete from platform_legacy_query_alias where old_id=10')

  if(mode==='incoming')t.exec('create table unknown_owner(collection_id integer references platform_query_title_scope_error(query_id))')
  if(mode==='trigger')t.exec('create trigger unknown_scope after insert on platform_query_title_scope begin select 1;end')
  if(mode==='index')t.exec('create index unknown_scope_idx on platform_query_title_scope(rdjb)')
  if(mode.startsWith('missing-t'))t.prepare('update platform_migration_run set state=? where run_id=?').run('running',mode.slice(8))
  t.close();const before=readFileSync(f.target)
  expect(()=>finalizeCollectionScopes({...f,...(mode==='wrong-run'?{finalizationRunId:'wrong'}:{}),...(mode==='inode'?{source:f.target}:{})})).toThrow()
  expect(readFileSync(f.target).equals(before)).toBe(true)
})
it.each(['source','source-schema','fact','schema','receipt','checkpoint','predecessor-receipt','predecessor-checkpoint','wrong-predecessor'])('completed successor replay rejects %s binding drift without writing',mode=>{
  const f=scopeFixture();finalizeCollectionScopes(f)
  const t=new Database(mode==='source'||mode==='source-schema'?f.source:f.target)
  if(mode==='source-schema')t.exec('create table unexpected_source(id integer)')
  if(mode==='source')t.exec("update platform_query set query_key='changed' where id=1")
  if(mode==='fact')t.exec("update platform_query_title_scope set rdjb='changed' where collection_id=10 and rdjb='2'")
  if(mode==='schema')t.exec('create table unexpected(id integer)')
  if(mode==='receipt'||mode==='predecessor-receipt')t.prepare('update platform_migration_run set transform_version=? where run_id=?').run('changed',mode==='receipt'?'w4pre':'t05c')
  if(mode==='checkpoint'||mode==='predecessor-checkpoint')t.prepare('update platform_migration_checkpoint set copied_count=999 where run_id=?').run(mode==='checkpoint'?'w4pre':'t05c')
  t.close();const before=readFileSync(f.target)
  expect(()=>finalizeCollectionScopes({...f,...(mode==='wrong-predecessor'?{finalizationRunId:'other'}:{})})).toThrow(/drift/)
  expect(readFileSync(f.target).equals(before)).toBe(true)
})
it('successor catalog matches final declarations and permits typed collection-only scope CRUD with FK safe IDs and PK enforcement',()=>{
  const f=scopeFixture();finalizeCollectionScopes(f);const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const queries:string[]=[],db=drizzle(t,{schema:final,logger:{logQuery:q=>queries.push(q)}})
  db.insert(final.platformCollection).values({id:1001,interface:'apply_list',queryKey:'new',rdjb:'',queriedAt:'now',createdAt:'now',status:'failed',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'test'}).run()
  db.insert(final.platformQueryTitleScope).values({collectionId:1001,rdjb:' 2 '}).run()
  db.insert(final.platformQueryTitleScopeError).values({collectionId:1001}).run()
  expect(db.select().from(final.platformQueryTitleScope).where(eq(final.platformQueryTitleScope.collectionId,1001)).all()).toEqual([{collectionId:1001,rdjb:' 2 '}])
  expect(db.select().from(final.platformQueryTitleScopeError).where(eq(final.platformQueryTitleScopeError.collectionId,1001)).all()).toEqual([{collectionId:1001}])
  expect(queries.join('\n')).not.toMatch(/"platform_(query|relation)"/)
  db.insert(final.platformCollection).values({id:9007199254740992,interface:'apply_list',queryKey:'unsafe-owner',rdjb:'',queriedAt:'now',createdAt:'now',status:'failed',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'test'}).run()
  for(const id of [9999,9007199254740992,0]){
    expect(()=>db.insert(final.platformQueryTitleScope).values({collectionId:id,rdjb:'x'}).run()).toThrow()
    expect(()=>db.insert(final.platformQueryTitleScopeError).values({collectionId:id}).run()).toThrow()
  }
  expect(()=>db.insert(final.platformQueryTitleScope).values({collectionId:1001,rdjb:' 2 '}).run()).toThrow()
  expect(()=>db.insert(final.platformQueryTitleScopeError).values({collectionId:1001}).run()).toThrow()
  expect(()=>db.delete(final.platformCollection).where(eq(final.platformCollection.id,1001)).run()).toThrow()
  expect(t.prepare('select id from platform_query where id=1001').all()).toEqual([])
  for(const table of [final.platformQueryTitleScope,final.platformQueryTitleScopeError]){
    const c=getTableConfig(table),actual=t.pragma(`table_info(${c.name})`) as {name:string,notnull:number,pk:number}[]
    expect(actual.map(x=>x.name)).toEqual(c.columns.map(x=>x.name))
    for(const col of c.columns)expect(actual.find(x=>x.name===col.name)?.notnull).toBe(Number(col.notNull))
    expect(actual.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>x.name)).toEqual(c.name.endsWith('_error')?['collection_id']:['collection_id','rdjb'])
    expect(t.pragma(`foreign_key_list(${c.name})`)).toEqual([expect.objectContaining({table:'platform_collection',from:'collection_id',to:'id',on_delete:'RESTRICT'})])
  }
  expect((t.pragma('index_info(platform_query_title_scope_rdjb_collection_idx)') as {name:string}[]).map(x=>x.name)).toEqual(['rdjb','collection_id'])
  expect(t.prepare("select name from sqlite_schema where type='trigger' and name like 'platform_query_title_scope_%'").all()).toEqual([])
  expect(t.prepare("select name from sqlite_schema where type='index' and name like 'platform_query_title_scope_%' order by name").all()).toEqual([{name:'platform_query_title_scope_rdjb_collection_idx'}])
  t.close()
})
it('successor CLI preserves manifests across process replay while old phase refuses',()=>{
  const f=scopeFixture(),e=join(f.root,'scope-cli');mkdirSync(e)
  const args=[cliArtifact(),'--collection-scopes',f.source,f.target,e,f.runId,f.projectionRunId,f.observationRunId,f.collectionRunId,f.finalizationRunId]
  const run=spawnSync(process.execPath,args,{encoding:'utf8'});expect(run.status,run.stderr).toBe(0)
  expect(JSON.parse(readFileSync(join(e,'receipt.json'),'utf8')).state).toBe('complete')
  expect(readFileSync(join(e,'schema-manifest.json'),'utf8')).toContain('platform_query_title_scope_safe_id')
  const next=join(f.root,'scope-replay');mkdirSync(next);args[4]=next
  const replay=spawnSync(process.execPath,args,{encoding:'utf8'});expect(replay.status,replay.stderr).toBe(0)
  expect(readFileSync(join(e,'target-manifest.jsonl')).equals(readFileSync(join(next,'target-manifest.jsonl')))).toBe(true)
  const before=readFileSync(f.target);expect(()=>finalizeObservations({...f,runId:f.finalizationRunId})).toThrow();expect(()=>upgradeCollections({...f,runId:f.collectionRunId,batchSize:2})).toThrow();expect(readFileSync(f.target).equals(before)).toBe(true)
})
it('successor retains frozen source lock through every DDL and receipt stage',()=>{
  const f=scopeFixture(),observed:string[]=[]
  finalizeCollectionScopes({...f,beforeCommit:stage=>{
    const run=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';const t=new Database(process.argv[1]);t.pragma('busy_timeout=1');try{t.exec("update platform_query set query_key='drift' where id=1")}catch(e){process.stdout.write(e.code)}finally{t.close()}`,f.source],{encoding:'utf8'})
    expect(run.stdout,run.stderr).toBe('SQLITE_BUSY');observed.push(stage)
  }})
  expect(observed).toEqual(['dropped','created','copied','indexed','receipt'])
})
it('empty and populated successor catalogs agree while ordinary expand remains unchanged',()=>{
  const f=scopeFixture(),empty=fixture(s=>s.exec('delete from platform_relation;delete from platform_query'))
  finalizeObservations(empty);finalizeCollectionScopes({...empty,runId:'empty-scopes',finalizationRunId:'t05c'});finalizeCollectionScopes(f)
  const p=new Database(f.target),e=new Database(empty.target),s=new Database(f.source)
  expect(finalizationCatalog(p)).toEqual(finalizationCatalog(e))
  expect((s.pragma('table_info(platform_query_title_scope)') as {name:string}[]).map(c=>c.name)).toEqual(['query_id','rdjb','collection_id'])
  expect(s.pragma('user_version',{simple:true})).toBe(0)
  expect(s.prepare("select name from sqlite_schema where type='trigger' and name like 'platform_query_title_scope_%'").all()).toHaveLength(3)
  p.close();e.close();s.close()
})
import { linkSync, statSync } from 'node:fs'
import { serialize } from 'node:v8'
it.each([71605,71606])('runtime initialize and all three source workers reject phase %i before business access',async version=>{
  const f=scopeFixture();if(version===71606)finalizeCollectionScopes(f)
  const {useRuntimeDb,initializeDb}=await import('../../../db/client')
  const before=readFileSync(f.target)
  for(const readOnly of [false,true])expect(()=>useRuntimeDb({dbPath:f.target,readOnly})).toThrow(/final platform runtime schema/i)
  expect(()=>initializeDb({dbPath:f.target})).toThrow(/final platform runtime schema/i)
  const {createImportExecutionWorker}=await import('../../../server/utils/import-execution-worker-location')
  const {createCurrentExportWorker}=await import('../../../server/utils/current-export-worker-location')
  const {createEnterpriseWorker}=await import('../../../layers/sme-roster/server/utils/enterprise-read-worker-location')
  const t=new Database(f.target),st=statSync(f.target)
  const identity={dev:st.dev,ino:st.ino,schemaVersion:t.pragma('schema_version',{simple:true}),migration:t.prepare('select hash,created_at from __drizzle_migrations order by created_at desc limit 1').get()};t.close()
  for(const [kind,create] of [['import',createImportExecutionWorker],['export',createCurrentExportWorker],['read',createEnterpriseWorker]] as const){
    const w=create()
    try{
      const result=await new Promise<Record<string,unknown>>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('worker timeout '+kind)),15000)
        w.on('error',reject)
        w.on('message',(m:Record<string,unknown>)=>{if(m.type!=='ready'&&m.type!=='progress'){clearTimeout(timer);resolve(m)}})
        w.postMessage({dbPath:f.target,id:'guard',identity,readonly:false,action:'preflight',payload:serialize({}),operation:'list',filter:{},title:'specialized_sme',temporaryPath:join(f.root,'never.xlsx'),jobId:'guard'})
      })
      if(kind==='import')expect(result).toMatchObject({type:'failure',error:{message:expect.stringMatching(/final platform runtime schema/i)}})
      if(kind==='export')expect(result).toEqual({type:'failure',message:'当前名录导出执行失败；请核对数据或资源限制后重新提交'})
      if(kind==='read')expect(result).toMatchObject({type:'failure',code:'enterprise_read_failed'})
    }finally{await w.terminate()}
  }
  expect(readFileSync(f.target).equals(before)).toBe(true)
},30000)
it('FK ON refuses absent collection and unsafe unmapped owner mutations before finalization',()=>{
  const f=scopeFixture(),t=new Database(f.target);expect(t.pragma('foreign_keys',{simple:true})).toBe(1)
  expect(()=>t.exec('delete from platform_collection where id=14')).toThrow(/FOREIGN KEY/)
  expect(()=>t.exec('update platform_query_title_scope_error set collection_id=9007199254740992 where query_id=12')).toThrow(/FOREIGN KEY/)
  t.close();expect(finalizeCollectionScopes(f).state).toBe('complete')
})

it('successor rejects distinct paths sharing a source inode without changing either file',()=>{
  const f=scopeFixture(),alias=join(f.root,'source-hardlink.sqlite'),source=readFileSync(f.source),target=readFileSync(f.target)
  linkSync(f.source,alias)
  expect(()=>finalizeCollectionScopes({...f,target:alias})).toThrow(/Distinct isolated target/)
  expect(readFileSync(f.source).equals(source)).toBe(true);expect(readFileSync(f.target).equals(target)).toBe(true)
})
