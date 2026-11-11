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

it.each(['fingerprint','rule','identity','reference-fingerprint'] as const)('independent rejects indexed observation drift %s', mode => {
  const input=command(evidence('businessList'))
  const {sqlite,db,source,frozenSource}=fixture(old=>{seedOriginalProbe(old,input);ensurePlatformObservation(drizzle(old,{schema:expand}),101)})
  const frozenHash=createHash('sha256').update(readFileSync(frozenSource)).digest('hex')
  const old=new Database(source), publicDb=drizzle(old,{schema:expand})
  const change=mode.includes('fingerprint')?"input_fingerprint='corrupted'":mode==='rule'?"projection_rule_version='corrupted'":"key_source='relation_key'"
  old.exec(`update platform_business_observation set ${change}`)
  sqlite.exec(`update platform_business_observation set ${change}`)
  const ordinary=replay(input,q=>{delete q.titleCode;if(mode==='reference-fingerprint'){q.reuseExisting=true;delete q.collectionEvidence;delete q.status;delete q.rawResponse;q.relations=[{sequenceNo:1}]}})
  const req={idempotencyKey:'independent-'+mode,sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[JSON.parse(ordinary.queryText)]}}
  const publicResult=preflightRosterImport(publicDb,req)
  const publicCommit=publicResult.preflight.conflicts.length?null:commitRosterImport(publicDb,req,[],{deferCandidateTasks:true})
  const before=bytes(sqlite)
  let targetResult:unknown,targetError:unknown
  try{targetResult=writeCollectionTarget(db,ordinary)}catch(e){targetError=e}
  const record={mode,publicResult,publicCommit,targetResult,targetError:targetError instanceof Error?targetError.message:targetError,frozenHash,frozenHashAfter:createHash('sha256').update(readFileSync(frozenSource)).digest('hex'),source,unchanged:before.equals(bytes(sqlite))}
  writeFileSync('/Users/mang/.t3/acceptance/platform-complete-migration/w4b-replay/post-capture/certified-counterexample-'+mode+'.json',JSON.stringify(record,null,2))
  old.close();sqlite.close()
  expect(record.frozenHashAfter).toBe(frozenHash)
  expect(publicResult.preflight.conflicts.length>0 || publicCommit?.status==='failed').toBe(true)
  expect(targetError,'target must refuse the same indexed observation drift').toBeDefined()
})
function seedOriginalProbe(old:Database.Database,input:NewCollectionTargetCommand){
  const q=JSON.parse(input.queryText)
  old.prepare('insert into platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) values(91,?,?,?,?,?,?,?,?)').run(q.interface,q.queryKey,q.rdjb ?? '',q.queriedAt,q.status,q.rawResponse ?? null,input.evidenceText,input.createdAt)
  for(const r of q.relations)old.prepare('insert into platform_relation(id,query_id,sequence_no,relation_key,name_raw,uscc_raw,raw_fields,created_at) values(?,91,?,?,?,?,?,?)').run(100+r.sequenceNo,r.sequenceNo,r.relationKey,r.nameRaw ?? null,r.usccRaw ?? null,JSON.stringify(r.rawFields),input.createdAt)
}
function replay(input: NewCollectionTargetCommand, mutate: (q: import('../lib/roster-import-client').RosterImportPlatformQuery) => void) {
  const q = JSON.parse(input.queryText); mutate(q)
  return { ...input,queryText:JSON.stringify(q),evidenceText:q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence) }
}
