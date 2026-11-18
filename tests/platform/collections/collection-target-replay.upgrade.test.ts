import { createRuntimeSchema } from '../../../db/create-runtime'
import { completePlatformMigration } from '../../../upgrade/complete-platform'
import { upgradeRecognizedQualification } from '../../../upgrade/recognized-qualification'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { writeCollectionTarget, type NewCollectionTargetCommand } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult, PlatformQuerySource } from '../../../layers/sme-roster/lib/platform/live-query'

const owned: {root:string;sqlite:Database.Database}[]=[]
afterEach(()=>{for(const f of owned.splice(0)){if(f.sqlite.open)f.sqlite.close();rmSync(f.root,{recursive:true,force:true})}})
// Cache only real completed migrations, keyed by the closed historical source bytes.
// Each test gets its own copy before any writer, trigger or projection mutation.
const pristineRoot = mkdtempSync(join(tmpdir(),'replay-migrations-'))
const legacyTemplate = join(pristineRoot, 'legacy.sqlite')
const migrated = new Map<string, { target: string; evidence: string }>()
beforeAll(() => {
  const old = new Database(legacyTemplate)
  try { migrate(drizzle(old), { migrationsFolder: 'db/migrations' }) } finally { old.close() }
})
afterAll(() => rmSync(pristineRoot, {recursive:true,force:true}))
function fixture(seed?: (old: Database.Database) => void) {
  const root = mkdtempSync(join(tmpdir(),'replay-fixture-'))
  const target = join(root, 'target.sqlite')
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) })
  owned.push({root,sqlite})
  sqlite.close()
  let source: string | undefined
  if (seed) {
    source = join(root, 'source.sqlite')
    copyFileSync(legacyTemplate, source)
    const old = new Database(source)
    try { seed(old) } finally { old.close() }
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex')
    let snapshot = migrated.get(hash)
    if (!snapshot) {
      const cacheRoot = join(pristineRoot, hash)
      mkdirSync(cacheRoot)
      const cachedSource = join(cacheRoot, 'source.sqlite')
      copyFileSync(source, cachedSource)
      snapshot = {target:join(cacheRoot, 'target.sqlite'), evidence:join(cacheRoot, 'native-evidence')}
      mkdirSync(snapshot.evidence)
      completePlatformMigration(cachedSource, snapshot.target, snapshot.evidence)
      migrated.set(hash, snapshot)
    }
    copyFileSync(snapshot.target, target)
    cpSync(snapshot.evidence, join(root, 'native-evidence'), {recursive:true})
  }
  const connection = new Database(target, { verbose: text => statements.push(String(text)) })
  owned[owned.length - 1]!.sqlite = connection
  connection.pragma('foreign_keys=ON')
  if (seed) connection.exec("insert into title(code,name_zh,level,rank) values('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3),('innovative_sme','创新型中小企业','municipal',1)")
  else createRuntimeSchema(connection)
  return {sqlite:connection, db:drizzle(connection, {schema:targetSchema}), statements, frozenSource:source!}
}
function evidence(source: PlatformQuerySource): PlatformLiveQueryResult {
  return { source, status: 'success', effectiveConditions: { name: 'Example', combination: 'and', ...(source === 'businessList' ? { name: undefined, uscc: '91330200712345678A' } : {}) }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: source === 'queryList' ? [] : ['2'] }, queriedAt: '2026-11-11T00:00:00Z', completedAt: '2026-11-11T00:01:00Z', rows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: 'false' }], dataRows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: false }], pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
function command(e: PlatformLiveQueryResult): NewCollectionTargetCommand {
  const query = platformResultToImport(e)
  return { queryText: JSON.stringify(query, null, 2), evidenceText: JSON.stringify(e, null, 1), createdAt: 'creation text', assignments: (query.relations ?? []).map(row => ({ enterpriseId: null, matchBasis: 'none' as const, verificationStatus: 'pending' as const, nameRaw: row.nameRaw?.trim() || null, origin: 'command' as const, actor: { type: 'agent' as const, id: 'w4a' }, basis: 'explicit input', recordedAt: null })) }
}

function bytes(sqlite: Database.Database) {
  const result = sqlite.serialize()
  for (const offset of [24, 92]) result.fill(0, offset, offset + 4)
  return result
}
function replay(input: NewCollectionTargetCommand, mutate: (q: import('../../../lib/roster-import-client').RosterImportPlatformQuery) => void) {
  const q = JSON.parse(input.queryText)
  mutate(q)
  return { ...input,queryText:JSON.stringify(q),evidenceText:q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence) }
}
it('rebuilds migrated not_indexed only for ordinary full raw replay without replacing its assignment or original aliases',() => {
  const input=command(evidence('businessList')), {sqlite,db}=fixture(old=>seedOriginal(old,input))
  const first=writeCollectionTarget(db,replay(input,q=>{delete q.titleCode;q.reuseExisting=true}))
  const ordinary=replay(input,q=>{delete q.titleCode})
  const assignment=sqlite.prepare('select * from platform_observation_assignment').all()
  const before=bytes(sqlite)
  writeCollectionTarget(db,replay(input,q=>{delete q.titleCode;q.reuseExisting=true}))
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  writeCollectionTarget(db,ordinary)
  expect(sqlite.prepare('select identity_state,content_state from platform_business_observation').all()).toEqual([{identity_state:'resolved',content_state:'verified'}])
  expect(sqlite.prepare('select * from platform_observation_assignment').all()).toEqual(assignment)
  expect(writeCollectionTarget(db,ordinary).observations[0]!.relationAlias).toBe(first.observations[0]!.relationAlias)
  sqlite.close()
})
function seedOriginal(old:Database.Database,input:NewCollectionTargetCommand){
  const q=JSON.parse(input.queryText)
  old.prepare('insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) values(91,?,?,?,?,?,?,?,?)').run(q.interface,q.queryKey,q.rdjb ?? '',q.queriedAt,q.status,q.rawResponse ?? null,input.evidenceText,input.createdAt)
  for(const r of q.relations)old.prepare('insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,uscc_raw,raw_fields,created_at) values(?,91,?,?,?,?,?,?)').run(100+r.sequenceNo,r.sequenceNo,r.relationKey,r.nameRaw ?? null,r.usccRaw ?? null,JSON.stringify(r.rawFields),input.createdAt)
}
it.each(['queryList','businessList','queryBusList'] as const)('replays migrated %s with original SQL aliases and immutable source binding',source=>{
  const collected=evidence(source)
  if(source==='queryBusList'){
    const recognized={rdtime:' 2023-12-28 08:50:25 ',sfyx:0,sxsj:'2026-11-16 12:00:01',sxyy:' 取消 ',szsfmc:' 浙江省 ',szsmc:'宁波市',szqmc:'海曙区',szq:'133020300'}
    Object.assign(collected.dataRows![0]!,recognized)
    Object.assign(collected.rows[0]!,{...recognized,sfyx:'0'})
  }
  const input=command(collected)
  const {sqlite,db,statements,frozenSource}=fixture(old=>seedOriginal(old,input))
  const frozenHash=createHash('sha256').update(readFileSync(frozenSource)).digest('hex')
  const originalArchives=sqlite.prepare('select r.field,a.* from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=101 order by r.field').all()
  if(source==='queryBusList')expect(sqlite.prepare('select source_recognized_at,source_valid_flag,source_invalidated_at,source_invalidation_reason,source_province_name,source_city_name,source_district_name,qualification_fields_rule from platform_recognized_projection where observation_id=101').get()).toEqual({source_recognized_at:null,source_valid_flag:null,source_invalidated_at:null,source_invalidation_reason:null,source_province_name:null,source_city_name:null,source_district_name:null,qualification_fields_rule:null})
  const reference=replay(input,q=>{delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const before=bytes(sqlite), result=writeCollectionTarget(db,reference)
  expect(result.queryAlias).toBe(91);expect(result.observations).toEqual([{observationId:101,recordId:null,versionId:null,relationAlias:101,reused:true}])
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  const bad=replay(reference,q=>{q.relations=[{sequenceNo:1,rawFields:null}]})
  expect(()=>writeCollectionTarget(db,bad)).toThrow('observation_payload_conflict')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  const assignment=sqlite.prepare('select * from platform_observation_assignment').all()
  const ordinary=replay(input,q=>{delete q.titleCode})
  const targetFull=writeCollectionTarget(db,ordinary)
  expect('item' in targetFull ? targetFull.item?.detail : null).toMatchObject({canonicalProjection:[{relationId:101,recordCreated:true,versionCreated:true,observationCreated:true,syncRequested:true}]})
  expect(sqlite.prepare('select id,identity_state,content_state from platform_business_observation').all()).toEqual([{id:101,identity_state:'resolved',content_state:'verified'}])
  expect(sqlite.prepare('select * from platform_observation_assignment').all()).toEqual(assignment)
  if(source==='queryBusList'){
    const expectedQualification={source_recognized_at:' 2023-12-28 08:50:25 ',source_valid_flag:0,source_invalidated_at:'2026-11-16 12:00:01',source_invalidation_reason:' 取消 ',source_province_name:' 浙江省 ',source_city_name:'宁波市',source_district_name:'海曙区',qualification_fields_rule:'recognized-qualification-fields-v1'}
    expect(sqlite.prepare('select source_recognized_at,source_valid_flag,source_invalidated_at,source_invalidation_reason,source_province_name,source_city_name,source_district_name,qualification_fields_rule from platform_recognized_projection where version_id is not null').get()).toEqual(expectedQualification)
    const indexed=sqlite.prepare('select * from platform_business_observation').all()
    const versions=sqlite.prepare('select * from platform_business_record_version').all()
    expect(upgradeRecognizedQualification(sqlite,{batchSize:100})).toEqual({captured:1,unavailable:0})
    expect(sqlite.prepare('select source_recognized_at,source_valid_flag,source_invalidated_at,source_invalidation_reason,source_province_name,source_city_name,source_district_name,qualification_fields_rule from platform_recognized_projection order by id').all()).toEqual([expectedQualification,expectedQualification])
    expect(sqlite.prepare('select * from platform_business_observation').all()).toEqual(indexed)
    expect(sqlite.prepare('select * from platform_business_record_version').all()).toEqual(versions)
    const captured=bytes(sqlite)
    expect(writeCollectionTarget(db,ordinary).observations).toEqual(targetFull.observations)
    expect(bytes(sqlite).equals(captured), 'captured replay preserves database bytes').toBe(true)
  }
  expect(sqlite.prepare('select r.field,a.* from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=101 order by r.field').all()).toEqual(originalArchives)
  expect(statements.filter(text=>/\b(platform_query|platform_relation)\b/i.test(text))).toEqual([])
  expect(createHash('sha256').update(readFileSync(frozenSource)).digest('hex')).toBe(frozenHash)
  // The complete chain has distinct authenticated predecessors; inspect its first source binding independently.
  const preparation=JSON.parse(readFileSync(join(sqlite.name,'..','native-evidence','source-preparation.json'),'utf8'))
  expect(preparation.originalSha256).toBe(frozenHash)
  const preparedHash=createHash('sha256').update(readFileSync(preparation.expandedSource)).digest('hex')
  expect(sqlite.prepare("select source_snapshot_sha256 h from platform_migration_run where run_id='complete-collections'").all()).toEqual([{h:preparedHash}])
  sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rolls back %s projection completion after terminal failure even when outer transaction catches',source=>{
  const input=command(evidence(source)),{sqlite,db}=fixture(old=>seedOriginal(old,input))
  sqlite.exec("create trigger inject before update on platform_business_observation begin select raise(abort,'repair-terminal'); end")
  const before=bytes(sqlite)
  db.transaction(tx=>{expect(()=>writeCollectionTarget(tx,replay(input,q=>{delete q.titleCode}))).toThrow('projection_source_drift')})
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each(['apply_list','business_list','recognized_list'] as const)('keeps %s source-specific migrated NULL-response sentinel semantics',interfaceName=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:interfaceName,queryKey:'legacy',rdjb:'',queriedAt:'time',status:'success',rawResponse:'original raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db}=fixture(old=>seedOriginal(old,input)),before=bytes(sqlite)
  const reference=replay(input,q=>{q.reuseExisting=true;q.rawResponse=null;q.relations=[{sequenceNo:1}]})
  if(interfaceName==='recognized_list')expect(()=>writeCollectionTarget(db,reference)).toThrow('query_payload_conflict')
  else expect(writeCollectionTarget(db,reference).queryAlias).toBe(91)
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it('retains insertion defaults for whitespace metadata and rdjb before replay lookup',()=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'key',rdjb:' 2 ',queriedAt:'time',failureReason:'  ',rawResponse:'raw',relations:[]}),evidenceText:null,createdAt:'c',assignments:[]}
  writeCollectionTarget(db,input)
  expect(sqlite.prepare('select rdjb,failure_reason from platform_collection').get()).toEqual({rdjb:'2',failure_reason:null})
  const before=bytes(sqlite);writeCollectionTarget(db,input);expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each([null,'',' '] as const)('preserves typed original key %s without normalizing reference assertions',key=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'business_list',queryKey:'legacy',rdjb:'',queriedAt:'time',status:'success',rawResponse:'original',relations:[{sequenceNo:1,relationKey:key,nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db}=fixture(old=>seedOriginal(old,input))
  const reference=replay(input,q=>{q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const before=bytes(sqlite)
  if(key===null){writeCollectionTarget(db,reference)}
  else{expect(()=>writeCollectionTarget(db,reference)).toThrow('observation_payload_conflict')}
  expect(sqlite.prepare('select source_relation_key from platform_business_observation').get()).toEqual({source_relation_key:key})
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})

it.each([null,'',' ',' A '] as const)('replays new target key %s using insertion semantics while retaining its original archived key and materialized typed key',key=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:key,rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null}))}
  writeCollectionTarget(db,input);const before=bytes(sqlite);writeCollectionTarget(db,input)
  expect(sqlite.prepare('select source_relation_key from platform_business_observation').get()).toEqual({source_relation_key:key?.trim() || null})
  const requestArchive=sqlite.prepare("SELECT a.bytes,a.sha256 FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.field='request'").get() as {bytes:Buffer;sha256:string}
  expect(requestArchive.bytes).toEqual(Buffer.from(input.queryText))
  expect(requestArchive.sha256).toBe(createHash('sha256').update(input.queryText).digest('hex'))
  expect(JSON.parse(requestArchive.bytes.toString()).relations[0].relationKey).toBe(key)
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each([{label:'queryKey',queryKey:' legacy ',queriedAt:'time'},{label:'queriedAt',queryKey:'legacy',queriedAt:' time '}])('retains transaction recheck for original whitespace $label without rewriting coordinates',({queryKey,queriedAt})=>{
  const {sqlite,db}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey,queriedAt,status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null}))}
  const first=writeCollectionTarget(db,input),before=bytes(sqlite),second=writeCollectionTarget(db,input)
  expect(second.queryAlias).toBe(first.queryAlias);expect(second.reused).toBe(true)
  const explicit=replay(input,q=>{q.reuseExisting=true})
  expect(()=>writeCollectionTarget(db,explicit)).toThrow('query_reuse_missing')
  expect(sqlite.prepare('select query_key,queried_at from platform_collection').get()).toEqual({query_key:queryKey,queried_at:queriedAt})
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
it.each([{samePayload:false,explicit:false},{samePayload:true,explicit:false},{samePayload:false,explicit:true},{samePayload:true,explicit:true}])('checks normalized planning and original transaction collections independently when samePayload=$samePayload explicit=$explicit',({samePayload,explicit})=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:"Example"}))}
  const {sqlite,db}=fixture(old=>{
    seedOriginal(old,input)
    old.prepare("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) values(92,'apply_list',' legacy ','','time','success','raw','c')").run()
    old.prepare("insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,raw_fields,created_at) values(102,92,1,?,'Example',?,'c')").run(samePayload?'A':'B',JSON.stringify({id:samePayload?'A':'B'}))
  })
  const requestInput=replay(input,q=>{q.queryKey=' legacy ';if(explicit)q.reuseExisting=true})
  const before=bytes(sqlite)
  if(samePayload){
    expect(writeCollectionTarget(db,requestInput)).toMatchObject({queryAlias:92,observations:[{observationId:102,relationAlias:102}]})
    expect(sqlite.prepare('select id,identity_state from platform_business_observation order by id').all()).toEqual([{id:101,identity_state:'not_indexed'},{id:102,identity_state:explicit?'not_indexed':'resolved'}])
  }else{
    try{writeCollectionTarget(db,requestInput);expect.fail('accepted wrong transaction source')}catch(error){expect(error).toMatchObject({result:{kind:'platform_relation',ref:'relation:102',error:{code:'observation_payload_conflict',field:'relations'}}})}
    expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  }
  sqlite.close()
})
it.each(['migrated','new'] as const)('retains own proto keys typed arrays and original raw bytes when a %s row is referenced',mode=>{
  const rawText='{"id":"A","__proto__":{"polluted":true},"array":[null,false," ",2]}'
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:JSON.parse(rawText)}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db}=fixture(mode==='migrated'?old=>seedOriginal(old,input):undefined)
  if(mode==='new'){writeCollectionTarget(db,{...input,assignments:command(evidence('queryList')).assignments})}
  const reference=replay(input,q=>{q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const before=bytes(sqlite);writeCollectionTarget(db,reference);expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  const archived = sqlite.prepare("select a.bytes,a.sha256 from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.owner_id=? and r.field='rawFields'").get(mode==='migrated'?101:1) as {bytes:Buffer;sha256:string}
  expect(archived.bytes).toEqual(Buffer.from(rawText))
  expect(archived.sha256).toBe(createHash('sha256').update(rawText).digest('hex'))
  const raw = JSON.parse(archived.bytes.toString())
  expect(Object.hasOwn(raw, '__proto__')).toBe(true)
  expect(raw.__proto__).toEqual({polluted:true})
  expect(raw.array).toEqual([null,false,' ',2])
  sqlite.close()
})
it('refuses missing observation source fidelity instead of inventing a projection from raw or latest shared version',()=>{
  const input=command(evidence('queryBusList')),{sqlite,db}=fixture(old=>seedOriginal(old,input)),ordinary=replay(input,q=>{delete q.titleCode})
  writeCollectionTarget(db,ordinary)
  expect(sqlite.prepare('select source_maintenance_year_absent v from platform_recognized_projection where observation_id=101').get()).toEqual({v:null})
  sqlite.exec('delete from platform_recognized_projection where observation_id=101')
  const before=bytes(sqlite)
  expect(()=>writeCollectionTarget(db,ordinary)).toThrow('projection_missing')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
