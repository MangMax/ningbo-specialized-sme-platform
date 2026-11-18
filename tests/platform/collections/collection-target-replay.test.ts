import { createRuntimeSchema } from '../../../db/create-runtime'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolveLegacyReference } from '../../../layers/sme-roster/lib/platform/target-archive'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { writeNewCollectionTarget, writeCollectionTarget, type NewCollectionTargetCommand } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult, PlatformQuerySource } from '../../../layers/sme-roster/lib/platform/live-query'


// Current replay owns no historical schema or migrated oracle.
const owned: {root:string;sqlite:Database.Database}[]=[]
afterEach(()=>{for(const f of owned.splice(0)){if(f.sqlite.open)f.sqlite.close();rmSync(f.root,{recursive:true,force:true})}})
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'native-collection-replay-'));
 const statements:string[]=[];
 const sqlite=new Database(join(root,'target.sqlite'),{verbose:text=>statements.push(String(text))});
 owned.push({root,sqlite}); sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite);
 return {sqlite,db:drizzle(sqlite,{schema:targetSchema}),statements};
}
function evidence(source: PlatformQuerySource): PlatformLiveQueryResult {
  return { source, status: 'success', effectiveConditions: { name: 'Example', combination: 'and', ...(source === 'businessList' ? { name: undefined, uscc: '91330200712345678A' } : {}) }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: source === 'queryList' ? [] : ['2'] }, queriedAt: '2026-11-11T00:00:00Z', completedAt: '2026-11-11T00:01:00Z', rows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: 'false' }], dataRows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: false }], pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
function command(e: PlatformLiveQueryResult): NewCollectionTargetCommand {
  const query = platformResultToImport(e)
  return { queryText: JSON.stringify(query, null, 2), evidenceText: JSON.stringify(e, null, 1), createdAt: 'creation text', assignments: (query.relations ?? []).map(row => ({ enterpriseId: null, matchBasis: 'none' as const, verificationStatus: 'pending' as const, nameRaw: row.nameRaw?.trim() || null, origin: 'command' as const, actor: { type: 'agent' as const, id: 'w4a' }, basis: 'explicit input', recordedAt: null })) }
}
function logicalCells(sqlite:Database.Database) {
  const tables=sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name:string}[]
  return tables.map(({name})=>{
    const cols=sqlite.prepare('PRAGMA table_info("'+name+'")').all() as {name:string;pk:number}[]
    const pk=cols.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>'"'+c.name+'"').join(',')||'rowid'
    const cells=cols.flatMap(c=>['typeof("'+c.name+'") AS "type_'+c.name+'"','hex(cast("'+c.name+'" AS blob)) AS "hex_'+c.name+'"']).join(',')
    return {name,rows:sqlite.prepare('SELECT '+cells+' FROM "'+name+'" ORDER BY '+pk).all()}
  })
}
function bytes(sqlite: Database.Database) {
  const result = sqlite.serialize()
  for (const offset of [24, 92]) result.fill(0, offset, offset + 4)
  return result
}
function replay(input: NewCollectionTargetCommand, mutate: (q: import('../../../layers/sme-roster/lib/roster-import-client').RosterImportPlatformQuery) => void) {
  const q = JSON.parse(input.queryText)
  mutate(q)
  return { ...input,queryText:JSON.stringify(q),evidenceText:q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence) }
}
it.each(['queryList','businessList','queryBusList'] as const)('replays %s without changing any fact or alias', source => {
  const {sqlite, db, statements} = fixture(), input = command(evidence(source))
  const first = writeCollectionTarget(db, input)
  const before = bytes(sqlite)
  const again = writeCollectionTarget(db, input)
  expect(again).toMatchObject({collectionId:first.collectionId, queryAlias:first.queryAlias, reused:true})
  expect(again.observations.map(x => [x.observationId,x.relationAlias,x.versionId])).toEqual(first.observations.map(x => [x.observationId,x.relationAlias,x.versionId]))
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  expect(statements.filter(text => /\b(platform_query|platform_relation)\b/i.test(text))).toEqual([])
  sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('keeps %s subset references and ownership decisions immutable',source => {
  const {sqlite,db} = fixture(), input = command(evidence(source))
  const first = writeCollectionTarget(db,input), before = bytes(sqlite)
  for (const relations of [undefined,[],[{sequenceNo:1,enterpriseId:null,matchBasis:'manual' as const,verificationStatus:'confirmed' as const}]]) {
    const result = writeCollectionTarget(db,replay(input,q => {delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.relations=relations}))
    expect(result.queryAlias).toBe(first.queryAlias)
    expect(result.observations).toHaveLength(relations?.length ?? 0)
    expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
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
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each(['apply_list','business_list'] as const)('retains %s omitted NULL empty and whitespace reference sentinels with typed payloads',interfaceName=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:interfaceName,queryKey:'legacy',queriedAt:'time',status:'partial',failureReason:'original',rawResponse:'original bytes',relations:[{sequenceNo:1,relationKey:'key',nameRaw:' Name ',status:' ',rawFields:{id:'key',zero:0,flag:false,n:null,blank:' ',rows:[2,1]}}]}),evidenceText:null,createdAt:'created',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:"Name"}))}
  writeCollectionTarget(db,input)
  const before=bytes(sqlite)
  for(const rawResponse of [undefined,null])for(const status of [undefined,null,'',' ']){
    const next=replay(input,q=>{q.rawResponse=rawResponse;delete q.status;delete q.failureReason;q.relations=[{sequenceNo:1,status}]})
    writeCollectionTarget(db,next);expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  }
  for(const rawResponse of ['',' ','null'])expect(()=>writeCollectionTarget(db,replay(input,q=>{q.rawResponse=rawResponse}))).toThrow('query_payload_conflict')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
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
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('atomically rechecks %s staged duplicates and rolls back an earlier new collection on a later conflict',source=>{
  const {sqlite,db}=fixture(), input=command(evidence(source)), before=logicalCells(sqlite)
  expect(()=>db.transaction(tx=>{
    const first=writeCollectionTarget(tx,input)
    expect(writeCollectionTarget(tx,input).queryAlias).toBe(first.queryAlias)
    writeCollectionTarget(tx,replay(input,q=>{delete q.collectionEvidence;q.reuseExisting=true;q.relations=[{sequenceNo:2}]}))
  })).toThrow('query_relation_set_conflict')
  // SQLite may retain rolled-back bytes on unreachable free pages; every persisted cell must be identical.
  expect(logicalCells(sqlite)).toEqual(before);sqlite.close()
})
it('rejects missing original explicit reuse without creating aliases or collections',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('queryBusList')),before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.reuseExisting=true;delete q.collectionEvidence;q.relations=[]}))).toThrow('query_reuse_missing')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it('rejects sealed archive drift instead of signing off a partial reference',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('businessList'))
  writeCollectionTarget(db,input)
  const triggers=sqlite.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_archive_value'").all() as {name:string}[]
  for(const {name}of triggers)sqlite.exec(`drop trigger "${name}"`)
  sqlite.exec("update platform_archive_value set bytes=cast(('x'||substr(cast(bytes as text),2)) as blob) where id=(select archive_id from platform_observation_archive_ref where field='rawFields' limit 1)")
  const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{delete q.collectionEvidence;q.reuseExisting=true;q.relations=[{sequenceNo:1}]}))).toThrow('Original archive drift')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it('retains existing last_collected_at and creates new-time collections even for identical content',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('queryBusList')),first=writeCollectionTarget(db,input)
  sqlite.exec("update platform_collection set last_collected_at='2026-11-11T00:30:00Z'")
  const before=bytes(sqlite);writeCollectionTarget(db,input);expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  const next=writeCollectionTarget(db,replay(input,q=>{q.queriedAt='2026-11-12T00:00:00Z';q.collectionEvidence!.queriedAt=q.queriedAt;q.collectionEvidence!.completedAt='2026-11-12T00:01:00Z'}))
  expect(next.collectionId).not.toBe(first.collectionId);expect(next.observations[0]!.observationId).not.toBe(first.observations[0]!.observationId);expect(next.observations[0]!.versionId).toBe(first.observations[0]!.versionId)
  expect(sqlite.prepare('select queried_at,last_collected_at from platform_collection order by id').all()).toEqual([{queried_at:'2026-11-11T00:00:00Z',last_collected_at:'2026-11-11T00:30:00Z'},{queried_at:'2026-11-12T00:00:00Z',last_collected_at:null}]);sqlite.close()
})
it('requires exact ordinary fullset and preserves empty legacy metadata assertions',()=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'key',queriedAt:'time',rawResponse:'raw',relations:[{sequenceNo:1,rawFields:{id:'A'}},{sequenceNo:2,rawFields:{id:'B'}}]}),evidenceText:null,createdAt:'c',assignments:[...command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null})),...command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null}))]}
  writeCollectionTarget(db,input);const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1}]}))).toThrow('query_relation_set_conflict')
  for(const value of [null,'',' '])writeCollectionTarget(db,replay(input,q=>{q.failureReason=value}))
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rejects %s changed evidence with original source-specific metadata code',source=>{
  const {sqlite,db}=fixture(),input=command(evidence(source));writeCollectionTarget(db,input);const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.collectionEvidence!.completedAt='2026-11-11T00:03:00Z'}))).toThrow(source==='queryBusList'?'collection_evidence_conflict':'query_payload_conflict')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it('uses optionalString coordinates and returns namespace aliases independently of target IDs',()=>{
  const input=command(evidence('businessList')), {sqlite,db}=fixture()
  sqlite.exec("update platform_legacy_alias_sequence set high_water=500 where namespace='query';update platform_legacy_alias_sequence set high_water=800 where namespace='relation'")
  const first=writeCollectionTarget(db,input), before=bytes(sqlite)
  const next=writeCollectionTarget(db,replay(input,q=>{delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.queryKey=` ${q.queryKey} `;q.rdjb=` ${q.rdjb} `;q.queriedAt=` ${q.queriedAt} `;q.relations=[{sequenceNo:1}]}))
  expect(next.queryAlias).toBe(501);expect(next.collectionId).toBe(1);expect(next.observations[0]!.relationAlias).toBe(801);expect(next.observations[0]!.observationId).toBe(1)
  expect(resolveLegacyReference(db,{version:1,kind:'relation',queryId:501,relationId:801})).toEqual({version:2,kind:'observation',collectionId:first.collectionId,observationId:first.observations[0]!.observationId})
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each([0,71605])('refuses replay phase %s without consulting or writing a legacy entity',phase=>{
  const {sqlite,db,statements}=fixture(),input=command(evidence('queryList'))
  writeCollectionTarget(db,input);sqlite.pragma(`user_version=${phase}`);const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,input)).toThrow('Final native platform schema required')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);expect(statements.filter(text=>/\b(platform_query|platform_relation)\b/i.test(text))).toEqual([]);sqlite.close()
})
it.each(['apply_list','business_list'] as const)('compares %s explicit normalized source fields while preserving original typed bytes',interfaceName=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:interfaceName,queryKey:'legacy',queriedAt:'time',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',status:null,year:null,rawFields:{id:'A',cszt:' 终审通过 ',year:' 2028 ',extra:[false,null,0,' ']}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null}))}
  writeCollectionTarget(db,input);const before=bytes(sqlite)
  writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1,status:' 终审通过 ',year:2028}]}))
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1,status:'退回'}]}))).toThrow('relation_payload_conflict')
  expect(()=>writeCollectionTarget(db,replay(input,q=>{q.relations=[{sequenceNo:1,status:'退回',rawFields:{id:'A',cszt:'终审通过'}}]}))).toThrow('platform_field_conflict')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rejects %s existing source projection drift with original relation alias and exact error',source=>{
  const {sqlite,db}=fixture(),input=command(evidence(source)),first=writeCollectionTarget(db,input)
  const table=source==='queryList'?'platform_apply_projection':source==='businessList'?'platform_business_projection':'platform_recognized_projection'
  const triggers=sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table) as {name:string;sql:string}[]
  for(const trigger of triggers)sqlite.exec('DROP TRIGGER "'+trigger.name+'"')
  sqlite.exec(`update ${table} set ${source==='queryBusList'?'district':'status'}='drift' where version_id is not null`)
  for(const trigger of triggers)sqlite.exec(trigger.sql)
  const before=bytes(sqlite)
  try{writeCollectionTarget(db,input);expect.fail('accepted projection drift')}catch(error){expect(error).toMatchObject({result:{ok:false,ref:`relation:${first.observations[0]!.relationAlias}`,error:{code:source==='queryList'?'apply_projection_conflict':source==='businessList'?'business_projection_conflict':'recognized_projection_conflict',field:'relations'}}})}
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it('preserves projection mapping conflict code field and original relation alias without repairing a different typed mapping',()=>{
  const {sqlite,db}=fixture(),input=command(evidence('businessList')),first=writeCollectionTarget(db,input),e=evidence('businessList')
  e.queriedAt='2026-11-12T00:00:00Z';e.completedAt='2026-11-12T00:01:00Z';e.rows[0]!.id='B';e.dataRows![0]!.id='B'
  const second=writeCollectionTarget(db,command(e))
  sqlite.prepare('update platform_business_observation set record_id=?,version_id=? where id=?').run(second.observations[0]!.recordId,second.observations[0]!.versionId,first.observations[0]!.observationId)
  const before=bytes(sqlite)
  try{writeCollectionTarget(db,input);expect.fail('accepted mapping drift')}catch(error){expect(error).toMatchObject({result:{ref:`relation:${first.observations[0]!.relationAlias}`,error:{code:'projection_mapping_conflict',field:'relations'}}})}
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
