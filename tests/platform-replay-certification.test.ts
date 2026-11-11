import { finalizeFingerprintBasis } from '../upgrade/fingerprint-basis'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { writeFileSync } from 'node:fs'
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
  const root = mkdtempSync('/Users/mang/.t3/acceptance/platform-complete-migration/w4b-replay/post-capture/fixture-')
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  const old = new Database(source)
  migrate(drizzle(old), { migrationsFolder: 'db/migrations' }); seed?.(old); old.close(); copyFileSync(source, target)
  const options = { source, target, collectionRunId: 'c', observationRunId: 'o', projectionRunId: 'p', finalizationRunId: 'f', batchSize: 2 }
  upgradeCollections({ ...options, runId: 'c' }); upgradeObservations({ ...options, runId: 'o' }); upgradeProjections({ ...options, runId: 'p' })
  finalizeObservations({ ...options, runId: 'f' }); finalizeCollectionScopes({ ...options, runId: 's' })
  const predecessor=target+'.71606';copyFileSync(target,predecessor)
  finalizeFingerprintBasis({source:predecessor,target,runId:'basis',predecessorRunId:'s',legacySource:source})
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

function seedOriginalProbe(old:Database.Database,input:NewCollectionTargetCommand){
  const q=JSON.parse(input.queryText)
  old.prepare('insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) values(91,?,?,?,?,?,?,?,?)').run(q.interface,q.queryKey,q.rdjb ?? '',q.queriedAt,q.status,q.rawResponse ?? null,input.evidenceText,input.createdAt)
  for(const r of q.relations)old.prepare('insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,uscc_raw,raw_fields,created_at) values(?,91,?,?,?,?,?,?)').run(100+r.sequenceNo,r.sequenceNo,r.relationKey,r.nameRaw ?? null,r.usccRaw ?? null,JSON.stringify(r.rawFields),input.createdAt)
}
function replay(input: NewCollectionTargetCommand, mutate: (q: import('../lib/roster-import-client').RosterImportPlatformQuery) => void) {
  const q = JSON.parse(input.queryText); mutate(q)
  return { ...input,queryText:JSON.stringify(q),evidenceText:q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence) }
}

import { beforeAll } from 'vitest'
const sources=['queryList','businessList','queryBusList'] as const
const baselines=new Map<string,{target:Buffer,public:Buffer,input:NewCollectionTargetCommand}>()
beforeAll(()=>{
 for(const source of sources) {
  const e=evidence(source)
  if(source==='queryBusList')e.effectiveConditions={name:'Example ',combination:'and'}
  const input=command(e)
  const q=JSON.parse(input.queryText);delete q.titleCode
  if(source!=='queryBusList'){delete q.collectionEvidence;q.queryKey='legacy';q.rawResponse='raw';input.evidenceText=null}
  input.queryText=JSON.stringify(q)
  const f=fixture(old=>{
   seedOriginalProbe(old,replay(input,q=>{q.queryKey=q.queryKey.trim()}))
   old.prepare("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) select 92,interface,query_key||' ',rdjb,queried_at,status,raw_response,collection_evidence,created_at from platform_query where id=91").run()
   old.prepare('insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,uscc_raw,raw_fields,created_at) select 102,92,sequence_no,relation_key,name_raw,uscc_raw,raw_fields,created_at from platform_relation where id=101').run()
   ensurePlatformObservation(drizzle(old,{schema:expand}),101);ensurePlatformObservation(drizzle(old,{schema:expand}),102)
  })
  baselines.set(source,{target:f.sqlite.serialize(),public:readFileSync(f.frozenSource),input});f.sqlite.close()
 }
},60000)
const cases=sources.flatMap(source=>[false,true].flatMap(reference=>[101,102].flatMap(owner=>['input_fingerprint','projection_rule_version','identity_state','content_state','key_source','record_id','version_id'].map(field=>({source,reference,owner,field})))))
it.each(cases)('certifies $source reference=$reference owner=$owner field=$field with literal errors and rollback',({source,reference,owner,field})=>{
 const base=baselines.get(source)!,sqlite=new Database(base.target),old=new Database(base.public)
 sqlite.pragma('foreign_keys=ON');old.pragma('foreign_keys=ON')
 const mutation=field==='input_fingerprint'||field==='projection_rule_version'?"'corrupted'":field==='identity_state'?"'missing'":field==='content_state'?"'raw_only'":field==='key_source'?"'relation_key'":'999'
 // Deliberate corruption only, independently on target and public copies.
 for(const t of [sqlite,old]) {t.pragma('foreign_keys=OFF');t.pragma('ignore_check_constraints=ON');t.exec(`update platform_business_observation set ${field}=${mutation} where ${t===sqlite?'id':'relation_id'}=${owner}`);t.pragma('foreign_keys=ON')}
 const input=replay(base.input,q=>{if(source!=='queryBusList')q.queryKey+=' ';if(reference){q.reuseExisting=true;delete q.status;delete q.rawResponse;delete q.collectionEvidence;q.relations=[{sequenceNo:1}]}})
 const request={idempotencyKey:'matrix',sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(input.queryText)]}}
 const publicDb=drizzle(old,{schema:expand}),preflight=preflightRosterImport(publicDb,request),commit=preflight.preflight.conflicts.length?null:commitRosterImport(publicDb,request,[],{deferCandidateTasks:true})
 const code=['input_fingerprint','projection_rule_version'].includes(field)?'projection_source_drift':'projection_mapping_conflict'
 // Old preflight validates F1 for the planning owner; commit validates the actual owner/mapping.
 if((!reference && owner===102) || code==='projection_source_drift') {
  const items=[...preflight.preflight.conflicts,...(commit?.items??[])]
  expect(items).toContainEqual(expect.objectContaining({kind:'platform_relation',ref:`relation:${owner}`,error:expect.objectContaining({code,field:'relations'})}))
 }
 const before=bytes(sqlite),db=drizzle(sqlite,{schema:targetSchema})
 db.transaction(()=>{expect(()=>writeCollectionTarget(db,input)).toThrowError(expect.objectContaining({result:expect.objectContaining({kind:'platform_relation',ref:`relation:${owner}`,error:expect.objectContaining({code,field:'relations'})})}));expect(bytes(sqlite)).toEqual(before)})
 expect(bytes(sqlite)).toEqual(before);old.close();sqlite.close()
})

it.each([false,true])('refuses FK OFF before replay writes including outer transaction=%s',outer=>{
 const base=baselines.get('businessList')!,sqlite=new Database(base.target),db=drizzle(sqlite,{schema:targetSchema})
 sqlite.pragma('foreign_keys=OFF');if(outer)sqlite.exec('BEGIN')
 const before=bytes(sqlite);expect(()=>writeCollectionTarget(db,base.input)).toThrow('foreign_keys=ON');expect(bytes(sqlite)).toEqual(before)
 if(outer)sqlite.exec('ROLLBACK');expect(bytes(sqlite)).toEqual(before);sqlite.close()
})
it.each(['missing','uncaptured','unknown'] as const)('refuses %s basis for ordinary and explicit reference without writes',fault=>{
 const base=baselines.get('businessList')!,sqlite=new Database(base.target),db=drizzle(sqlite,{schema:targetSchema})
 sqlite.pragma('foreign_keys=ON')
 for(const row of sqlite.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_observation_fingerprint_basis'").all() as {name:string}[])sqlite.exec(`drop trigger "${row.name}"`)
 sqlite.pragma('ignore_check_constraints=ON')
 sqlite.exec(fault==='missing'?'delete from platform_observation_fingerprint_basis where observation_id=101':fault==='uncaptured'?"update platform_observation_fingerprint_basis set scheme='uncaptured',input_archive_id=null where observation_id=101":"update platform_observation_fingerprint_basis set scheme='unknown' where observation_id=101")
 const before=bytes(sqlite)
 for(const reference of [false,true])expect(()=>writeCollectionTarget(db,replay(base.input,q=>{if(reference){q.reuseExisting=true;q.relations=[{sequenceNo:1}]}}))).toThrowError(expect.objectContaining({result:expect.objectContaining({kind:'platform_relation',ref:'relation:101',error:expect.objectContaining({code:'projection_source_drift',field:'relations'})})}))
 expect(bytes(sqlite)).toEqual(before);sqlite.close()
})

import { emptyFingerprintTarget } from '../lib/platform/fingerprint-verifier'
it.each(sources)('certifies %s captured extra own keys and revision2 but refuses revision1 drift',source=>{
 const baseline=new Database(baselines.get(source)!.target),sqlite=emptyFingerprintTarget(baseline);baseline.close()
 sqlite.exec("insert into title(code,name_zh,level,rank) values('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3),('innovative_sme','创新型中小企业','municipal',1)")
 const db=drizzle(sqlite,{schema:targetSchema}),input=command(evidence(source))
 input.assignments=input.assignments.map(a=>({...a,extraFingerprintInput:'retained',commandReceiptId:null}))
 const first=writeCollectionTarget(db,input),id=first.observations[0]!.observationId
 sqlite.prepare("insert into platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin,actor,basis) values(?,2,'none','pending','command','{}','later')").run(id)
 const before=bytes(sqlite);writeCollectionTarget(db,input);writeCollectionTarget(db,replay(input,q=>{q.reuseExisting=true;delete q.collectionEvidence;q.relations=[{sequenceNo:1}]}));expect(bytes(sqlite)).toEqual(before)
 for(const row of sqlite.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_observation_assignment'").all() as {name:string}[])sqlite.exec(`drop trigger "${row.name}"`)
 sqlite.prepare("update platform_observation_assignment set basis='drift' where observation_id=? and revision=1").run(id)
 const corrupted=bytes(sqlite)
 expect(()=>writeCollectionTarget(db,input)).toThrowError(expect.objectContaining({result:expect.objectContaining({kind:'platform_relation',ref:`relation:${first.observations[0]!.relationAlias}`,error:expect.objectContaining({code:'projection_mapping_conflict',field:'relations'})})}))
 expect(bytes(sqlite)).toEqual(corrupted);sqlite.close()
})
