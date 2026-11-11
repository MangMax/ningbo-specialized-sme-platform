import * as expand from '../db/schema'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { createHash } from 'node:crypto'
import { resolveLegacyReference } from '../lib/platform/target-archive'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../upgrade/finalize-observations'
import { targetSchema } from '../lib/platform/target-schema'
import { writeNewCollectionTarget, writeCollectionTarget, type NewCollectionTargetCommand } from '../lib/platform/collection-target-command'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult, PlatformQuerySource } from '../lib/platform/live-query'

function fixture(seed?: (old: Database.Database) => void) {
  const root = mkdtempSync('/Users/mang/.t3/acceptance/platform-complete-migration/w4b-replay/raw/fixture-')
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  const old = new Database(source)
  migrate(drizzle(old), { migrationsFolder: 'db/migrations' }); seed?.(old); old.close(); copyFileSync(source, target)
  const options = { source, target, collectionRunId: 'c', observationRunId: 'o', projectionRunId: 'p', finalizationRunId: 'f', batchSize: 2 }
  upgradeCollections({ ...options, runId: 'c' }); upgradeObservations({ ...options, runId: 'o' }); upgradeProjections({ ...options, runId: 'p' })
  finalizeObservations({ ...options, runId: 'f' }); finalizeCollectionScopes({ ...options, runId: 's' })
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) }); sqlite.pragma('foreign_keys=ON'); sqlite.exec("insert into title(code,name_zh,level,rank) values('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3),('innovative_sme','创新型中小企业','municipal',1)")
  return { sqlite, db: drizzle(sqlite, { schema: targetSchema }), statements, frozenSource:source,
    get source() {
      const oracle = join(root,'public-oracle.sqlite')
      if(!existsSync(oracle))copyFileSync(source,oracle)
      return oracle
    },
  }
}
function evidence(source: PlatformQuerySource): PlatformLiveQueryResult {
  return { source, status: 'success', effectiveConditions: { name: 'Example', combination: 'and', ...(source === 'businessList' ? { name: undefined, uscc: '91330200712345678A' } : {}) }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: source === 'queryList' ? [] : ['2'] }, queriedAt: '2026-11-11T00:00:00Z', completedAt: '2026-11-11T00:01:00Z', rows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: 'false' }], dataRows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: false }], pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
function command(e: PlatformLiveQueryResult): NewCollectionTargetCommand {
  const query = platformResultToImport(e)
  return { queryText: JSON.stringify(query, null, 2), evidenceText: JSON.stringify(e, null, 1), createdAt: 'creation text', assignments: (query.relations ?? []).map(() => ({ enterpriseId: null, matchBasis: 'none' as const, verificationStatus: 'pending' as const, origin: 'command' as const, actor: { type: 'agent' as const, id: 'w4a' }, basis: 'explicit input', recordedAt: null })) }
}

function bytes(sqlite: Database.Database) {
  const result = sqlite.serialize()
  for (const offset of [24, 92]) result.fill(0, offset, offset + 4)
  return result
}
it.each(['queryList','businessList','queryBusList'] as const)('replays %s without changing any fact or alias', source => {
  const {sqlite, db, statements} = fixture(), input = command(evidence(source))
  const first = writeCollectionTarget(db, input)
  const before = bytes(sqlite)
  const again = writeCollectionTarget(db, input)
  expect(again).toMatchObject({collectionId:first.collectionId, queryAlias:first.queryAlias, reused:true})
  expect(again.observations.map(x => [x.observationId,x.relationAlias,x.versionId])).toEqual(first.observations.map(x => [x.observationId,x.relationAlias,x.versionId]))
  expect(bytes(sqlite)).toEqual(before)
  expect(statements.filter(text => /\b(platform_query|platform_relation)\b/i.test(text))).toEqual([])
  sqlite.close()
})
function replay(input: NewCollectionTargetCommand, mutate: (q: import('../lib/roster-import-client').RosterImportPlatformQuery) => void) {
  const q = JSON.parse(input.queryText)
  mutate(q)
  return { ...input,queryText:JSON.stringify(q),evidenceText:q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence) }
}
it.each(['queryList','businessList','queryBusList'] as const)('keeps %s subset references and ownership decisions immutable',source => {
  const {sqlite,db} = fixture(), input = command(evidence(source))
  const first = writeCollectionTarget(db,input), before = bytes(sqlite)
  for (const relations of [undefined,[],[{sequenceNo:1,enterpriseId:null,matchBasis:'manual' as const,verificationStatus:'confirmed' as const}]]) {
    const result = writeCollectionTarget(db,replay(input,q => {delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.relations=relations}))
    expect(result.queryAlias).toBe(first.queryAlias)
    expect(result.observations).toHaveLength(relations?.length ?? 0)
    expect(bytes(sqlite)).toEqual(before)
  }
  sqlite.close()
})
it.each([
  ['raw','observation_payload_conflict','relations'],['key','observation_payload_conflict','relations'],
  ['name','relation_payload_conflict','relations.nameRaw'],['metadata','query_payload_conflict','failureReason'],
  ['new-sequence','query_relation_set_conflict','relations'],['rawResponse','query_payload_conflict','rawResponse'],
] as const)('rejects explicit %s conflict with original code field alias and all facts unchanged', (kind,code,field) => {
  const {sqlite,db} = fixture(), input = command(evidence('businessList'))
  const first = writeCollectionTarget(db,input), before = bytes(sqlite)
  const next = replay(input,q => {
    delete q.collectionEvidence; q.reuseExisting=true
    if(kind==='raw')q.relations=[{sequenceNo:1,rawFields:null}]
    if(kind==='key')q.relations=[{sequenceNo:1,relationKey:'different'}]
    if(kind==='name')q.relations=[{sequenceNo:1,nameRaw:null}]
    if(kind==='metadata')q.failureReason='different'
    if(kind==='new-sequence')q.relations=[{sequenceNo:2}]
    if(kind==='rawResponse')q.rawResponse='null'
  })
  try {writeCollectionTarget(db,next);expect.fail('accepted conflict')} catch(error) {
    expect(error).toMatchObject({result:{ok:false,ref:kind==='raw'||kind==='key'||kind==='name'?`relation:${first.observations[0]!.relationAlias}`:`query:${first.queryAlias}`,error:{code,field}}})
  }
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it('rebuilds migrated not_indexed only for ordinary full raw replay without replacing its assignment or original aliases',() => {
  const {sqlite,db} = fixture(), input = command(evidence('businessList'))
  const first=writeCollectionTarget(db,input)
  // This target-state oracle mirrors the accepted paired not_indexed branch.
  sqlite.exec('delete from platform_business_projection where version_id is not null; update platform_business_observation set record_id=null,version_id=null,identity_state=\'not_indexed\',content_state=\'not_indexed\',key_source=null,projection_rule_version=null,input_fingerprint=null,indexed_at=null')
  const assignment=sqlite.prepare('select * from platform_observation_assignment').all()
  const before=bytes(sqlite)
  writeCollectionTarget(db,replay(input,q=>{q.reuseExisting=true}))
  expect(bytes(sqlite)).toEqual(before)
  writeCollectionTarget(db,input)
  expect(sqlite.prepare('select identity_state,content_state from platform_business_observation').all()).toEqual([{identity_state:'resolved',content_state:'verified'}])
  expect(sqlite.prepare('select * from platform_observation_assignment').all()).toEqual(assignment)
  expect(writeCollectionTarget(db,input).observations[0]!.relationAlias).toBe(first.observations[0]!.relationAlias)
  sqlite.close()
})
it.each(['apply_list','business_list'] as const)('retains %s omitted NULL empty and whitespace reference sentinels with typed payloads',interfaceName=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:interfaceName,queryKey:'legacy',queriedAt:'time',status:'partial',failureReason:'original',rawResponse:'original bytes',relations:[{sequenceNo:1,relationKey:'key',nameRaw:' Name ',status:' ',rawFields:{id:'key',zero:0,flag:false,n:null,blank:' ',rows:[2,1]}}]}),evidenceText:null,createdAt:'created',assignments:command(evidence('queryList')).assignments}
  writeCollectionTarget(db,input)
  const before=bytes(sqlite)
  for(const rawResponse of [undefined,null])for(const status of [undefined,null,'',' ']){
    const next=replay(input,q=>{q.rawResponse=rawResponse;delete q.status;delete q.failureReason;q.relations=[{sequenceNo:1,status}]})
    writeCollectionTarget(db,next);expect(bytes(sqlite)).toEqual(before)
  }
  for(const rawResponse of ['',' ','null'])expect(()=>writeCollectionTarget(db,replay(input,q=>{q.rawResponse=rawResponse}))).toThrow('query_payload_conflict')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
},15000)
it('requires full row set for ordinary replay while explicit reference may select a typed subset',()=>{
  const {sqlite,db}=fixture(), e=evidence('businessList')
  e.rows.push({...e.rows[0]!,id:'B'});e.dataRows!.push({...e.dataRows![0]!,id:'B'});e.fetchedCount=e.declaredTotal=2;e.pages[0]!.fetchedCount=e.pages[0]!.declaredTotal=2
  const input=command(e);const first=writeCollectionTarget(db,input);const before=bytes(sqlite)
  const subset=replay(input,q=>{delete q.collectionEvidence;q.relations=[{sequenceNo:2}];q.rawResponse='materialized'})
  expect(()=>writeCollectionTarget(db,subset)).toThrow('query_payload_conflict')
  const ordinary=replay(input,q=>{delete q.collectionEvidence;delete q.rawResponse;q.relations=[{sequenceNo:2}]})
  // Captured evidence means null response alone does not declare full materialized replay.
  writeCollectionTarget(db,ordinary)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{delete q.collectionEvidence;q.rawResponse=null;q.relations=[{sequenceNo:2}];q.collectionEvidence=null}))).toThrow('query_payload_conflict')
  const result=writeCollectionTarget(db,replay(input,q=>{delete q.collectionEvidence;delete q.rawResponse;q.reuseExisting=true;q.relations=[{sequenceNo:2}]}))
  expect(result.observations[0]!.relationAlias).toBe(first.observations[1]!.relationAlias)
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('atomically rechecks %s staged duplicates and rolls back an earlier new collection on a later conflict',source=>{
  const {sqlite,db}=fixture(), input=command(evidence(source)), before=bytes(sqlite)
  expect(()=>db.transaction(tx=>{
    const first=writeCollectionTarget(tx,input)
    expect(writeCollectionTarget(tx,input).queryAlias).toBe(first.queryAlias)
    writeCollectionTarget(tx,replay(input,q=>{delete q.collectionEvidence;q.reuseExisting=true;q.relations=[{sequenceNo:2}]}))
  })).toThrow('query_relation_set_conflict')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it('rejects missing original explicit reuse without creating aliases or collections',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('queryBusList')),before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.reuseExisting=true;delete q.collectionEvidence;q.relations=[]}))).toThrow('query_reuse_missing')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it('rejects sealed archive drift instead of signing off a partial reference',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('businessList'))
  writeCollectionTarget(db,input)
  const triggers=sqlite.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_archive_value'").all() as {name:string}[]
  for(const {name}of triggers)sqlite.exec(`drop trigger "${name}"`)
  sqlite.exec("update platform_archive_value set bytes=cast(('x'||substr(cast(bytes as text),2)) as blob) where id=(select archive_id from platform_observation_archive_ref where field='rawFields' limit 1)")
  const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{delete q.collectionEvidence;q.reuseExisting=true;q.relations=[{sequenceNo:1}]}))).toThrow('Original archive drift')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it('retains existing last_collected_at and creates new-time collections even for identical content',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('queryBusList')),first=writeCollectionTarget(db,input)
  sqlite.exec("update platform_collection set last_collected_at='2026-11-11T00:30:00Z'")
  const before=bytes(sqlite);writeCollectionTarget(db,input);expect(bytes(sqlite)).toEqual(before)
  const next=writeCollectionTarget(db,replay(input,q=>{q.queriedAt='2026-11-12T00:00:00Z';q.collectionEvidence!.queriedAt=q.queriedAt;q.collectionEvidence!.completedAt='2026-11-12T00:01:00Z'}))
  expect(next.collectionId).not.toBe(first.collectionId);expect(next.observations[0]!.observationId).not.toBe(first.observations[0]!.observationId);expect(next.observations[0]!.versionId).toBe(first.observations[0]!.versionId)
  expect(sqlite.prepare('select queried_at,last_collected_at from platform_collection order by id').all()).toEqual([{queried_at:'2026-11-11T00:00:00Z',last_collected_at:'2026-11-11T00:30:00Z'},{queried_at:'2026-11-12T00:00:00Z',last_collected_at:null}]);sqlite.close()
})
function seedOriginal(old:Database.Database,input:NewCollectionTargetCommand){
  const q=JSON.parse(input.queryText)
  old.prepare('insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) values(91,?,?,?,?,?,?,?,?)').run(q.interface,q.queryKey,q.rdjb ?? '',q.queriedAt,q.status,q.rawResponse ?? null,input.evidenceText,input.createdAt)
  for(const r of q.relations)old.prepare('insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,uscc_raw,raw_fields,created_at) values(?,91,?,?,?,?,?,?)').run(100+r.sequenceNo,r.sequenceNo,r.relationKey,r.nameRaw ?? null,r.usccRaw ?? null,JSON.stringify(r.rawFields),input.createdAt)
}
it.each(['queryList','businessList','queryBusList'] as const)('replays migrated %s against independent public preflight commit and original SQL aliases',source=>{
  const input=command(evidence(source))
  const {sqlite,db,source:sourcePath,statements,frozenSource}=fixture(old=>seedOriginal(old,input))
  const frozenHash=createHash('sha256').update(readFileSync(frozenSource)).digest('hex')
  const old=new Database(sourcePath), publicDb=drizzle(old,{schema:expand})
  const reference=replay(input,q=>{delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const q=JSON.parse(reference.queryText)
  const req={idempotencyKey:'w4b-reference',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[q]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  const before=bytes(sqlite), result=writeCollectionTarget(db,reference)
  expect(result.queryAlias).toBe(91);expect(result.observations).toEqual([{observationId:101,recordId:null,versionId:null,relationAlias:101,reused:true}])
  expect(bytes(sqlite)).toEqual(before)
  const bad=replay(reference,q=>{q.relations=[{sequenceNo:1,rawFields:null}]})
  const rejected=preflightRosterImport(publicDb,{...req,idempotencyKey:'w4b-bad',payload:{platformQueries:[JSON.parse(bad.queryText)]}})
  expect(rejected.preflight.conflicts[0]).toMatchObject({ref:'relation:101',error:{code:'observation_payload_conflict',field:'relations'}})
  expect(()=>writeCollectionTarget(db,bad)).toThrow('observation_payload_conflict')
  expect(bytes(sqlite)).toEqual(before)
  const assignment=sqlite.prepare('select * from platform_observation_assignment').all()
  const ordinary=replay(input,q=>{delete q.titleCode})
  const publicFull=commitRosterImport(publicDb,{...req,idempotencyKey:'w4b-full',payload:{platformQueries:[JSON.parse(ordinary.queryText)]}},[],{deferCandidateTasks:true})
  expect(publicFull.status).toBe('committed')
  const targetFull=writeCollectionTarget(db,ordinary)
  expect('item' in targetFull ? targetFull.item?.detail : null).toMatchObject({canonicalProjection:[{relationId:101,recordCreated:true,versionCreated:true,observationCreated:true,syncRequested:true}]})
  expect(publicFull.items[0]!.detail).toMatchObject({canonicalProjection:[{relationId:101,recordCreated:true,versionCreated:true,observationCreated:true,syncRequested:true}]})
  expect(sqlite.prepare('select id,identity_state,content_state from platform_business_observation').all()).toEqual([{id:101,identity_state:'resolved',content_state:'verified'}])
  expect(sqlite.prepare('select * from platform_observation_assignment').all()).toEqual(assignment)
  expect(statements.filter(text=>/\b(platform_query|platform_relation)\b/i.test(text))).toEqual([])
  expect(createHash('sha256').update(readFileSync(frozenSource)).digest('hex')).toBe(frozenHash)
  expect(sqlite.prepare('select distinct source_snapshot_sha256 h from platform_migration_run').all()).toEqual([{h:frozenHash}])
  old.close();sqlite.close()
})
it('requires exact ordinary fullset and preserves empty legacy metadata assertions',()=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'key',queriedAt:'time',rawResponse:'raw',relations:[{sequenceNo:1,rawFields:{id:'A'}},{sequenceNo:2,rawFields:{id:'B'}}]}),evidenceText:null,createdAt:'c',assignments:[...command(evidence('queryList')).assignments,...command(evidence('queryList')).assignments]}
  writeCollectionTarget(db,input);const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1}]}))).toThrow('query_relation_set_conflict')
  for(const value of [null,'',' '])writeCollectionTarget(db,replay(input,q=>{q.failureReason=value}))
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rolls back %s projection completion after terminal failure even when outer transaction catches',source=>{
  const input=command(evidence(source)),{sqlite,db}=fixture(old=>seedOriginal(old,input))
  sqlite.exec("create trigger inject before update on platform_business_observation begin select raise(abort,'repair-terminal'); end")
  const before=bytes(sqlite)
  db.transaction(tx=>{expect(()=>writeCollectionTarget(tx,replay(input,q=>{delete q.titleCode}))).toThrow('repair-terminal')})
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rejects %s changed evidence with original source-specific metadata code',source=>{
  const {sqlite,db}=fixture(),input=command(evidence(source));writeCollectionTarget(db,input);const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.collectionEvidence!.completedAt='2026-11-11T00:03:00Z'}))).toThrow(source==='queryBusList'?'collection_evidence_conflict':'query_payload_conflict')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it('uses optionalString coordinates and returns namespace aliases independently of target IDs',()=>{
  const input=command(evidence('businessList')), {sqlite,db}=fixture()
  sqlite.exec("update platform_legacy_alias_sequence set high_water=500 where namespace='query';update platform_legacy_alias_sequence set high_water=800 where namespace='relation'")
  const first=writeCollectionTarget(db,input), before=bytes(sqlite)
  const next=writeCollectionTarget(db,replay(input,q=>{delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.queryKey=` ${q.queryKey} `;q.rdjb=` ${q.rdjb} `;q.queriedAt=` ${q.queriedAt} `;q.relations=[{sequenceNo:1}]}))
  expect(next.queryAlias).toBe(501);expect(next.collectionId).toBe(1);expect(next.observations[0]!.relationAlias).toBe(801);expect(next.observations[0]!.observationId).toBe(1)
  expect(resolveLegacyReference(db,{version:1,kind:'relation',queryId:501,relationId:801})).toEqual({version:2,kind:'observation',collectionId:first.collectionId,observationId:first.observations[0]!.observationId})
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('repairs %s missing version projection only after ordinary raw assertion and returns compatible summary',source=>{
  const {sqlite,db}=fixture(),input=command(evidence(source)),first=writeCollectionTarget(db,input)
  const table=source==='queryList'?'platform_apply_projection':source==='businessList'?'platform_business_projection':'platform_recognized_projection'
  sqlite.exec(`delete from ${table} where version_id is not null`)
  const before=bytes(sqlite)
  writeCollectionTarget(db,replay(input,q=>{q.reuseExisting=true}));expect(bytes(sqlite)).toEqual(before)
  const repaired=writeCollectionTarget(db,input)
  expect('item' in repaired ? repaired.item : null).toMatchObject({ok:true,ref:`query:${first.queryAlias}`,detail:{rowsWritten:0,skipped:1,reuseExisting:true,canonicalProjection:[{relationId:first.observations[0]!.relationAlias,observationCreated:false,recordCreated:false,versionCreated:false,syncRequested:true}]}})
  expect(sqlite.prepare(`select count(*) n from ${table} where version_id is not null`).get()).toEqual({n:1})
  const after=bytes(sqlite);writeCollectionTarget(db,input);expect(bytes(sqlite)).toEqual(after);sqlite.close()
})
it.each([0,71605])('refuses replay phase %s without consulting or writing a legacy entity',phase=>{
  const {sqlite,db,statements}=fixture(),input=command(evidence('queryList'))
  writeCollectionTarget(db,input);sqlite.pragma(`user_version=${phase}`);const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,input)).toThrow('Explicit 71606 target required')
  expect(bytes(sqlite)).toEqual(before);expect(statements.filter(text=>/\b(platform_query|platform_relation)\b/i.test(text))).toEqual([]);sqlite.close()
})
it.each(['apply_list','business_list'] as const)('compares %s explicit normalized source fields while preserving original typed bytes',interfaceName=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:interfaceName,queryKey:'legacy',queriedAt:'time',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',status:null,year:null,rawFields:{id:'A',cszt:' 终审通过 ',year:' 2028 ',extra:[false,null,0,' ']}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments}
  writeCollectionTarget(db,input);const before=bytes(sqlite)
  writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1,status:' 终审通过 ',year:2028}]}))
  expect(bytes(sqlite)).toEqual(before)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1,status:'退回'}]}))).toThrow('relation_payload_conflict')
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1,status:'退回',rawFields:{id:'A',cszt:'终审通过'}}]}))).toThrow('platform_field_conflict')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['apply_list','business_list','recognized_list'] as const)('keeps %s source-specific migrated NULL-response sentinel semantics',interfaceName=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:interfaceName,queryKey:'legacy',rdjb:'',queriedAt:'time',status:'success',rawResponse:'original raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db}=fixture(old=>seedOriginal(old,input)),before=bytes(sqlite)
  const reference=replay(input,q=>{q.reuseExisting=true;q.rawResponse=null;q.relations=[{sequenceNo:1}]})
  if(interfaceName==='recognized_list')expect(()=>writeCollectionTarget(db,reference)).toThrow('query_payload_conflict')
  else expect(writeCollectionTarget(db,reference).queryAlias).toBe(91)
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rejects %s existing source projection drift with original relation alias and exact error',source=>{
  const {sqlite,db}=fixture(),input=command(evidence(source)),first=writeCollectionTarget(db,input)
  const table=source==='queryList'?'platform_apply_projection':source==='businessList'?'platform_business_projection':'platform_recognized_projection'
  sqlite.exec(`update ${table} set ${source==='queryBusList'?'district':'status'}='drift' where version_id is not null`)
  const before=bytes(sqlite)
  try{writeCollectionTarget(db,input);expect.fail('accepted projection drift')}catch(error){expect(error).toMatchObject({result:{ok:false,ref:`relation:${first.observations[0]!.relationAlias}`,error:{code:source==='queryList'?'apply_projection_conflict':source==='businessList'?'business_projection_conflict':'recognized_projection_conflict',field:'relations'}}})}
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it('retains public legacy insertion defaults for whitespace metadata and rdjb before replay lookup',()=>{
  const {sqlite,db,source}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'key',rdjb:' 2 ',queriedAt:'time',failureReason:'  ',rawResponse:'raw',relations:[]}),evidenceText:null,createdAt:'c',assignments:[]}
  const old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const req={idempotencyKey:'w4b-defaults',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  expect(old.prepare('select rdjb,failure_reason from platform_query').get()).toEqual({rdjb:'2',failure_reason:null})
  old.close()
  writeCollectionTarget(db,input)
  expect(sqlite.prepare('select rdjb,failure_reason from platform_collection').get()).toEqual({rdjb:'2',failure_reason:null})
  const before=bytes(sqlite);writeCollectionTarget(db,input);expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each([null,'',' '] as const)('preserves typed original key %s and independently matches public original-payload assertion',key=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'business_list',queryKey:'legacy',rdjb:'',queriedAt:'time',status:'success',rawResponse:'original',relations:[{sequenceNo:1,relationKey:key,nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db,source}=fixture(old=>seedOriginal(old,input)),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const reference=replay(input,q=>{q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const req={idempotencyKey:'w4b-key',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(reference.queryText)]}}
  const publicResult=preflightRosterImport(publicDb,req),before=bytes(sqlite)
  if(key===null){expect(publicResult.preflight.conflicts).toEqual([]);writeCollectionTarget(db,reference)}
  else{expect(publicResult.preflight.conflicts[0]).toMatchObject({ref:'relation:101',error:{code:'observation_payload_conflict',field:'relations'}});expect(()=>writeCollectionTarget(db,reference)).toThrow('observation_payload_conflict')}
  expect(sqlite.prepare('select source_relation_key from platform_business_observation').get()).toEqual({source_relation_key:key})
  expect(bytes(sqlite)).toEqual(before);old.close();sqlite.close()
})

it.each([-1,0,1.5,Number.MAX_SAFE_INTEGER+1])('matches public missing-sequence error for typed coordinate %s without adding rows',sequenceNo=>{
  const input=command(evidence('businessList')),{sqlite,db,source}=fixture(old=>seedOriginal(old,input)),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const reference=replay(input,q=>{delete q.collectionEvidence;delete q.titleCode;q.reuseExisting=true;q.relations=[{sequenceNo}]})
  const req={idempotencyKey:'w4b-sequence',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(reference.queryText)]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts[0]).toMatchObject({ref:'query:91',error:{code:'query_relation_set_conflict',field:'relations'}})
  const before=bytes(sqlite)
  try{writeCollectionTarget(db,reference);expect.fail('accepted sequence')}catch(error){expect(error).toMatchObject({result:{ref:'query:91',error:{code:'query_relation_set_conflict',field:'relations'}}})}
  expect(bytes(sqlite)).toEqual(before);old.close();sqlite.close()
})
it.each([null,'',' ',' A '] as const)('replays new target key %s using public insertion semantics while retaining its original typed key',key=>{
  const {sqlite,db,source}=fixture(),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:key,rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments}
  const req={idempotencyKey:'w4b-new-key',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}}
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  expect(preflightRosterImport(publicDb,{...req,idempotencyKey:'w4b-new-key-replay'}).preflight.conflicts).toEqual([])
  writeCollectionTarget(db,input);const before=bytes(sqlite);writeCollectionTarget(db,input)
  expect(sqlite.prepare('select source_relation_key from platform_business_observation').get()).toEqual({source_relation_key:key})
  expect(bytes(sqlite)).toEqual(before);old.close();sqlite.close()
})
it.each([{label:'queryKey',queryKey:' legacy ',queriedAt:'time'},{label:'queriedAt',queryKey:'legacy',queriedAt:' time '}])('retains public transaction recheck for original whitespace $label without rewriting coordinates',({queryKey,queriedAt})=>{
  const {sqlite,db,source}=fixture(),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey,queriedAt,status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments}
  const req={idempotencyKey:'w4b-coordinate',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}}
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  const again={...req,idempotencyKey:'w4b-coordinate-again'}
  expect(preflightRosterImport(publicDb,again).preflight.conflicts).toEqual([])
  expect(commitRosterImport(publicDb,again,[],{deferCandidateTasks:true})).toMatchObject({status:'committed',summary:{written:0}})
  const first=writeCollectionTarget(db,input),before=bytes(sqlite),second=writeCollectionTarget(db,input)
  expect(second.queryAlias).toBe(first.queryAlias);expect(second.reused).toBe(true)
  const explicit=replay(input,q=>{q.reuseExisting=true})
  expect(preflightRosterImport(publicDb,{...req,idempotencyKey:'w4b-coordinate-explicit',payload:{platformQueries:[JSON.parse(explicit.queryText)]}}).preflight.conflicts[0]).toMatchObject({error:{code:'query_reuse_missing',field:'reuseExisting'}})
  expect(()=>writeCollectionTarget(db,explicit)).toThrow('query_reuse_missing')
  expect(sqlite.prepare('select query_key,queried_at from platform_collection').get()).toEqual({query_key:queryKey,queried_at:queriedAt})
  expect(bytes(sqlite)).toEqual(before);old.close();sqlite.close()
})
it.each([{samePayload:false,explicit:false},{samePayload:true,explicit:false},{samePayload:false,explicit:true},{samePayload:true,explicit:true}])('checks normalized planning and original transaction collections independently when samePayload=$samePayload explicit=$explicit',({samePayload,explicit})=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments}
  const {sqlite,db,source}=fixture(old=>{
    seedOriginal(old,input)
    old.prepare("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) values(92,'apply_list',' legacy ','','time','success','raw','c')").run()
    old.prepare("insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,raw_fields,created_at) values(102,92,1,?,'Example',?,'c')").run(samePayload?'A':'B',JSON.stringify({id:samePayload?'A':'B'}))
  })
  const old=new Database(source),publicDb=drizzle(old,{schema:expand}),requestInput=replay(input,q=>{q.queryKey=' legacy ';if(explicit)q.reuseExisting=true})
  const req={idempotencyKey:'w4b-double-owner',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(requestInput.queryText)]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  const result=commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}),before=bytes(sqlite)
  if(samePayload){
    expect(result).toMatchObject({status:'committed',items:[{ref:'query:92'}]})
    expect(writeCollectionTarget(db,requestInput)).toMatchObject({queryAlias:92,observations:[{observationId:102,relationAlias:102}]})
    expect(sqlite.prepare('select id,identity_state from platform_business_observation order by id').all()).toEqual([{id:101,identity_state:'not_indexed'},{id:102,identity_state:explicit?'not_indexed':'resolved'}])
  }else{
    expect(result.status).toBe('failed')
    expect(result.items).toContainEqual(expect.objectContaining({kind:'platform_relation',ref:'relation:102',error:expect.objectContaining({code:'observation_payload_conflict',field:'relations'})}))
    try{writeCollectionTarget(db,requestInput);expect.fail('accepted wrong transaction source')}catch(error){expect(error).toMatchObject({result:{kind:'platform_relation',ref:'relation:102',error:{code:'observation_payload_conflict',field:'relations'}}})}
    expect(bytes(sqlite)).toEqual(before)
  }
  old.close();sqlite.close()
})
it('preserves projection mapping conflict code field and original relation alias without repairing a different typed mapping',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('businessList')),first=writeCollectionTarget(db,input),e=evidence('businessList')
  e.queriedAt='2026-11-12T00:00:00Z';e.completedAt='2026-11-12T00:01:00Z';e.rows[0]!.id='B';e.dataRows![0]!.id='B'
  const second=writeCollectionTarget(db,command(e))
  sqlite.prepare('update platform_business_observation set record_id=?,version_id=? where id=?').run(second.observations[0]!.recordId,second.observations[0]!.versionId,first.observations[0]!.observationId)
  const before=bytes(sqlite)
  try{writeCollectionTarget(db,input);expect.fail('accepted mapping drift')}catch(error){expect(error).toMatchObject({result:{ref:`relation:${first.observations[0]!.relationAlias}`,error:{code:'projection_mapping_conflict',field:'relations'}}})}
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['migrated','new'] as const)('retains own proto keys typed arrays and original raw bytes when a %s row is referenced',mode=>{
  const rawText='{"id":"A","__proto__":{"polluted":true},"array":[null,false," ",2]}'
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:JSON.parse(rawText)}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db,source}=fixture(mode==='migrated'?old=>seedOriginal(old,input):undefined),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  if(mode==='new'){expect(commitRosterImport(publicDb,{idempotencyKey:'w4b-proto-create',sourceKind:'platform_archive',sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}},[],{deferCandidateTasks:true}).status).toBe('committed');writeCollectionTarget(db,{...input,assignments:command(evidence('queryList')).assignments})}
  const reference=replay(input,q=>{q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const req={idempotencyKey:'w4b-own-proto',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(reference.queryText)]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  const before=bytes(sqlite);writeCollectionTarget(db,reference);expect(bytes(sqlite)).toEqual(before)
  expect(sqlite.prepare("select cast(a.bytes as text) bytes from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.owner_id=? and r.field='rawFields'").get(mode==='migrated'?101:1)).toEqual({bytes:rawText})
  old.close();sqlite.close()
})
it('refuses missing observation source fidelity instead of inventing a projection from raw or latest shared version',()=>{
  const input=command(evidence('queryBusList')),{sqlite,db}=fixture(old=>seedOriginal(old,input)),ordinary=replay(input,q=>{delete q.titleCode})
  writeCollectionTarget(db,ordinary)
  expect(sqlite.prepare('select source_maintenance_year_absent v from platform_recognized_projection where observation_id=101').get()).toEqual({v:null})
  sqlite.exec('delete from platform_recognized_projection where observation_id=101')
  const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,ordinary)).toThrow('projection_missing')
  expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
