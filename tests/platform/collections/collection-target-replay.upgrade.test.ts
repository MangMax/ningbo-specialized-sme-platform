import { createRuntimeSchema } from '../../../db/create-runtime'
import { completePlatformMigration } from '../../../upgrade/complete-platform'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { verifyFingerprint } from '../../../lib/platform/fingerprint-verifier'
import * as expand from '../../../db/schema'
import { preflightRosterImport, commitRosterImport } from '../../../server/utils/roster-import'
import { createHash } from 'node:crypto'
import { resolveLegacyReference } from '../../../lib/platform/target-archive'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { targetSchema } from '../../../lib/platform/target-schema'
import { writeNewCollectionTarget, writeCollectionTarget, type NewCollectionTargetCommand } from '../../../lib/platform/collection-target-command'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult, PlatformQuerySource } from '../../../lib/platform/live-query'

const owned: {root:string;sqlite:Database.Database}[]=[]
afterEach(()=>{for(const f of owned.splice(0)){if(f.sqlite.open)f.sqlite.close();rmSync(f.root,{recursive:true,force:true})}})
let closedLegacyTemplate: string | undefined
function prepareTarget(root: string, seed?: (old: Database.Database) => void) {
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  if (closedLegacyTemplate) copyFileSync(closedLegacyTemplate, source)
  const old = new Database(source)
  if (!closedLegacyTemplate) migrate(drizzle(old), { migrationsFolder: 'db/migrations' })
  seed?.(old); old.close()
  const evidencePath=join(root,'native-evidence');mkdirSync(evidencePath)
  completePlatformMigration(source,target,evidencePath)
  return { source, target }
}
let pristine: ReturnType<typeof prepareTarget>
const pristineRoot = mkdtempSync(join(tmpdir(),'w4b-pristine-'))
beforeAll(() => { pristine = prepareTarget(pristineRoot); closedLegacyTemplate = pristine.source }, 30000)
afterAll(() => rmSync(pristineRoot, {recursive:true,force:true}))
function fixture(seed?: (old: Database.Database) => void) {
  const root = mkdtempSync(join(tmpdir(),'w4b-fixture-'))
  const { source, target } = seed ? prepareTarget(root,seed) : {
    source: join(root,'source.sqlite'), target: join(root,'target.sqlite'),
  }
  if (!seed) { copyFileSync(pristine.source,source); const native = new Database(target); native.pragma('foreign_keys=ON'); createRuntimeSchema(native); native.close() }
  const predecessor=source
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) }); sqlite.pragma('foreign_keys=ON'); if (seed) sqlite.exec("insert into title(code,name_zh,level,rank) values('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3),('innovative_sme','创新型中小企业','municipal',1)")
  owned.push({root,sqlite})
  return { sqlite, db: drizzle(sqlite, { schema: targetSchema }), statements, frozenSource:source, predecessor,
    get source() {
      const oracle = join(root,'public-oracle.sqlite')
      if(!existsSync(oracle)){const evidence=join(root,'oracle-evidence');mkdirSync(evidence);completePlatformMigration(source,oracle,evidence)}
      return oracle
    },
  }
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
it.each(['queryList','businessList','queryBusList'] as const)('replays migrated %s against independent public preflight commit and original SQL aliases',source=>{
  const input=command(evidence(source))
  const {sqlite,db,source:sourcePath,statements,frozenSource,predecessor}=fixture(old=>seedOriginal(old,input))
  const frozenHash=createHash('sha256').update(readFileSync(frozenSource)).digest('hex')
  const old=new Database(sourcePath), publicDb=drizzle(old,{schema:expand})
  const reference=replay(input,q=>{delete q.collectionEvidence;delete q.status;delete q.titleCode;delete q.rawResponse;q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const q=JSON.parse(reference.queryText)
  const req={idempotencyKey:'w4b-reference',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[q]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  const before=bytes(sqlite), result=writeCollectionTarget(db,reference)
  expect(result.queryAlias).toBe(91);expect(result.observations).toEqual([{observationId:101,recordId:null,versionId:null,relationAlias:101,reused:true}])
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  const bad=replay(reference,q=>{q.relations=[{sequenceNo:1,rawFields:null}]})
  const rejected=preflightRosterImport(publicDb,{...req,idempotencyKey:'w4b-bad',payload:{platformQueries:[JSON.parse(bad.queryText)]}})
  expect(rejected.preflight.conflicts[0]).toMatchObject({ref:'relation:101',error:{code:'observation_payload_conflict',field:'relations'}})
  expect(()=>writeCollectionTarget(db,bad)).toThrow('observation_payload_conflict')
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
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
  // The complete chain has distinct authenticated predecessors; inspect its first source binding independently.
  const preparation=JSON.parse(readFileSync(join(sqlite.name,'..','native-evidence','source-preparation.json'),'utf8'))
  expect(preparation.originalSha256).toBe(frozenHash)
  const preparedHash=createHash('sha256').update(readFileSync(preparation.expandedSource)).digest('hex')
  expect(sqlite.prepare("select source_snapshot_sha256 h from platform_migration_run where run_id='complete-collections'").all()).toEqual([{h:preparedHash}])
  old.close();sqlite.close()
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
it('retains public legacy insertion defaults for whitespace metadata and rdjb before replay lookup',()=>{
  const {sqlite,db,source}=fixture()
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'key',rdjb:' 2 ',queriedAt:'time',failureReason:'  ',rawResponse:'raw',relations:[]}),evidenceText:null,createdAt:'c',assignments:[]}
  const old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const req={idempotencyKey:'w4b-defaults',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  expect(old.prepare('select rdjb,failure_reason from platform_collection').get()).toEqual({rdjb:'2',failure_reason:null})
  old.close()
  writeCollectionTarget(db,input)
  expect(sqlite.prepare('select rdjb,failure_reason from platform_collection').get()).toEqual({rdjb:'2',failure_reason:null})
  const before=bytes(sqlite);writeCollectionTarget(db,input);expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
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
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);old.close();sqlite.close()
}, 10000)

it.each([null,'',' ',' A '] as const)('replays new target key %s using public insertion semantics while retaining its original archived key and materialized typed key',key=>{
  const {sqlite,db,source}=fixture(),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:key,rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null}))}
  const req={idempotencyKey:'w4b-new-key',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}}
  expect(commitRosterImport(publicDb,req,[],{deferCandidateTasks:true}).status).toBe('committed')
  expect(preflightRosterImport(publicDb,{...req,idempotencyKey:'w4b-new-key-replay'}).preflight.conflicts).toEqual([])
  writeCollectionTarget(db,input);const before=bytes(sqlite);writeCollectionTarget(db,input)
  expect(sqlite.prepare('select source_relation_key from platform_business_observation').get()).toEqual({source_relation_key:key?.trim() || null})
  const requestArchive=sqlite.prepare("SELECT a.bytes,a.sha256 FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.field='request'").get() as {bytes:Buffer;sha256:string}
  expect(requestArchive.bytes).toEqual(Buffer.from(input.queryText))
  expect(requestArchive.sha256).toBe(createHash('sha256').update(input.queryText).digest('hex'))
  expect(JSON.parse(requestArchive.bytes.toString()).relations[0].relationKey).toBe(key)
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);old.close();sqlite.close()
})
it.each([{label:'queryKey',queryKey:' legacy ',queriedAt:'time'},{label:'queriedAt',queryKey:'legacy',queriedAt:' time '}])('retains public transaction recheck for original whitespace $label without rewriting coordinates',({queryKey,queriedAt})=>{
  const {sqlite,db,source}=fixture(),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey,queriedAt,status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null}))}
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
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);old.close();sqlite.close()
})
it.each([{samePayload:false,explicit:false},{samePayload:true,explicit:false},{samePayload:false,explicit:true},{samePayload:true,explicit:true}])('checks normalized planning and original transaction collections independently when samePayload=$samePayload explicit=$explicit',({samePayload,explicit})=>{
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:{id:'A'}}]}),evidenceText:null,createdAt:'c',assignments:command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:"Example"}))}
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
    expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  }
  old.close();sqlite.close()
})
it.each(['migrated','new'] as const)('retains own proto keys typed arrays and original raw bytes when a %s row is referenced',mode=>{
  const rawText='{"id":"A","__proto__":{"polluted":true},"array":[null,false," ",2]}'
  const input:NewCollectionTargetCommand={queryText:JSON.stringify({interface:'apply_list',queryKey:'legacy',queriedAt:'time',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:'Example',rawFields:JSON.parse(rawText)}]}),evidenceText:null,createdAt:'c',assignments:[]}
  const {sqlite,db,source}=fixture(mode==='migrated'?old=>seedOriginal(old,input):undefined),old=new Database(source),publicDb=drizzle(old,{schema:expand})
  if(mode==='new'){expect(commitRosterImport(publicDb,{idempotencyKey:'w4b-proto-create',sourceKind:'platform_archive',sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}},[],{deferCandidateTasks:true}).status).toBe('committed');writeCollectionTarget(db,{...input,assignments:command(evidence('queryList')).assignments})}
  const reference=replay(input,q=>{q.reuseExisting=true;q.relations=[{sequenceNo:1}]})
  const req={idempotencyKey:'w4b-own-proto',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(reference.queryText)]}}
  expect(preflightRosterImport(publicDb,req).preflight.conflicts).toEqual([])
  const before=bytes(sqlite);writeCollectionTarget(db,reference);expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
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
  expect(bytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true);sqlite.close()
})
