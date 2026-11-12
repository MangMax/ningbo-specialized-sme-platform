import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { preflightRosterImport, commitRosterImport, replayRosterImport } from '../server/utils/roster-import'
import { readQueryCoverage } from '../lib/roster/query-assessment'
import { readDecision102, saveDecision102 } from '../server/utils/decision-lifecycle-102'
import { readEvidenceToken113, processEvidenceImpacts113 } from '../server/utils/evidence-impact-113'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { createServer } from 'node:http'
import { importExecutor } from '../server/utils/import-execution'
import { createRosterImportHandler } from '../server/utils/roster-import-route'
import * as h3 from 'h3'
import { assertExpandRuntime } from '../db/schema-phase'
import { z } from 'zod'
import { listImpacts114, impactList114, closeReviewSnapshots114 } from '../server/utils/evidence-review-114'
import { readTargetPlatformEvidence } from '../lib/platform/target-evidence-read'

vi.mock('@db', () => ({ useDb: () => db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
let f: Awaited<ReturnType<typeof witnessReaderFixture>>, t: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
let serial = 0
const trace: string[] = []
async function targetFixture(seed: (old: Database.Database) => void) {
  const fixture = await witnessReaderFixture(seed)
  fixture.close()
  const p = join(fixture.root, '71609.sqlite'); copyFileSync(fixture.target, p)
  finalizeProcessStored({ source: p, target: fixture.target, runId: 'process751', predecessorRunId: 'witness', legacySource: fixture.legacySource })
  const c = join(fixture.root, '71610.sqlite'); copyFileSync(fixture.target, c)
  transferCorrespondence({ source: c, target: fixture.target, runId: 'correspondence751' })
  const d = join(fixture.root, '71611.sqlite'); copyFileSync(fixture.target, d)
  transferDifferenceReferences({ source: d, target: fixture.target, runId: 'difference751' })
  return fixture
}
beforeAll(async () => {
  f = await targetFixture(old => old.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha','91330200712345678A'),(2,'Beta','Beta','91330200712345678B')"))
})
beforeEach(() => {
  const p = join(f.root, `case-${++serial}.sqlite`); copyFileSync(f.target, p)
  t = new Database(p, { verbose: q => trace.push(String(q)) }); t.pragma('foreign_keys=ON')
  db = drizzle(t, { schema })
  reserveLegacyIds(drizzle(t, { schema: targetSchema }), { query: 8000, relation: 9000 })
  trace.length = 0
})
it('resolves same-batch and persisted natural references and literal aliases with exactly one physical difference FK conversion', () => {
  const input = request([collection('queryBusList')])
  const q = input.payload.platformQueries![0]!
  const ref = { interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, sequenceNo: 1, relationKey: 'NORMAL' }
  input.payload.differences = [{ enterpriseName: 'Alpha', uscc: '91330200712345678A', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-11-13T01:00:00Z', evidenceQueryRef: ref, evidenceRelationRef: ref }]
  expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
  expect(commit(input)).toMatchObject({ status: 'committed', items: [{ ref: 'query:8001' }, { detail: { evidenceQueryId: 8001, evidenceRelationId: 9001 } }] })
  expect(t.prepare('select evidence_query_id q,evidence_relation_id r from difference_reason').get()).toEqual({ q: 1, r: 1 })
  const next = request([], 'persisted'); next.sourceKind = 'alias_evidence'
  next.payload.differences = [{ ...input.payload.differences[0]!, recordedAt: '2026-11-13T02:00:00Z' }]
  expect(preflightRosterImport(db,next).preflight.conflicts).toEqual([])
  expect(commit(next)).toMatchObject({status:'committed'})
  const literal = { ...next, idempotencyKey: 'literal', payload: { differences: [{ ...next.payload.differences[0]!, recordedAt: '2026-11-13T03:00:00Z', evidenceQueryRef: undefined, evidenceRelationRef: undefined, evidenceQueryId: 8001, evidenceRelationId: 9001 }] } }
  expect(commit(literal)).toMatchObject({status:'committed'})
  expect(t.prepare('select evidence_query_id q,evidence_relation_id r from difference_reason').all()).toEqual([{ q: 1, r: 1 }, { q: 1, r: 1 }, { q: 1, r: 1 }])
  noLegacy()
})
it('preserves mixed-source summaries and creates new observations only at a new time', () => {
  const sources = ['queryList','businessList','queryBusList'].map(s => collection(s as PlatformLiveQueryResult['source']))
  const result = commit(request(sources))
  expect(result).toMatchObject({ status: 'committed', summary: { written: 6, canonicalProjection: { recordsCreated: 3, versionsCreated: 3, observationsCreated: 3 } } })
  const atNewTime = commit(request(sources.map(s => ({ ...s, queriedAt: '2026-11-14T00:00:00Z', completedAt: '2026-11-14T00:00:00Z' })), 'next'))
  expect(atNewTime).toMatchObject({ status: 'committed', summary: { written: 6, canonicalProjection: { recordsCreated: 0, versionsCreated: 0, observationsCreated: 3 } } })
  expect(t.prepare('select count(*) n from platform_business_observation').get()).toEqual({ n: 6 })
  expect(t.prepare('select count(*) n from platform_business_record_version').get()).toEqual({ n: 3 })
  noLegacy()
})
it.each(['queryList','businessList','queryBusList'] as const)('retains %s ordinary coordinate replay subset references own-property conflicts and exact archives', source => {
  const input = request([collection(source)])
  expect(commit(input).status).toBe('committed')
  const again = commit({ ...input, idempotencyKey: 'coordinate' })
  expect(again).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1, canonicalProjection: { observationsCreated: 0, observationsReused: 1 } } })
  const q = input.payload.platformQueries![0]!
  const reference = { interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, reuseExisting: true as const, relations: [{ sequenceNo: 1 }] }
  const reuse = { ...input, idempotencyKey: 'reference', payload: { platformQueries: [reference] } }
  expect(commit(reuse)).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1, platformFields: { status: 'partial' } } })
  expect(commit({ ...reuse, idempotencyKey: 'bad-reference', payload: { platformQueries: [{ ...reference, relations: [{ sequenceNo: 2 }] }] } })).toMatchObject({ status: 'failed', items: [{ error: { code: 'query_relation_set_conflict' } }] })
  expect(commit({ ...reuse, idempotencyKey: 'null-assertion', payload: { platformQueries: [{ ...reference, failureReason: 'changed' }] } })).toMatchObject({ status: 'failed', items: [{ error: { code: 'query_payload_conflict' } }] })
  const bytes = t.prepare("select cast(v.bytes as text) value from platform_collection_archive_ref r join platform_archive_value v on v.id=r.archive_id where r.field='request'").get()
  expect(bytes).toEqual({ value: JSON.stringify(q) })
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual({ n: 1 })
  noLegacy()
})
afterEach(() => { closeReviewSnapshots114(); vi.restoreAllMocks(); vi.useRealTimers(); t?.close() })
afterAll(() => vi.unstubAllGlobals())

function collection(source: PlatformLiveQueryResult['source'] = 'businessList', time = '2026-11-13T00:00:00Z', rows: Record<string,string>[] = [{ id: 'NORMAL', rdjb: '2', qymc: 'Alpha', tyshxydm: '91330200712345678A', cszt: '终审通过', year: '2024', sblx: '申请' }]): PlatformLiveQueryResult {
  return { source, status: rows.length ? 'success' : 'no_record', effectiveConditions: { uscc: '91330200712345678A', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: ['2'] },
    queriedAt: time, completedAt: time, rows, dataRows: rows,
    pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, fetchedCount: rows.length, declaredTotal: rows.length, status: 'success', error: null }],
    fetchedCount: rows.length, declaredTotal: rows.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 } }
}
function request(sources = [collection()], key = 'normal'): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'synthetic-751', payload: { platformQueries: sources.map(platformResultToImport) } }
}
function commit(input: RosterImportRequest) { return commitRosterImport(db,input,[],{deferCandidateTasks:true}) }
function noLegacy() {
  expect(trace.filter(q => /\b(?:from|join|into|update)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  expect(t.pragma('foreign_key_check')).toEqual([])
}
const scope = { enterpriseId: 1, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
it.each(['queryList','businessList','queryBusList'] as const)('admits migrated %s reference and ordinary bootstrap through the complete import coordinator', async source => {
  const q=platformResultToImport(collection(source))
  const fixture=await targetFixture(old=>{
    old.exec("insert into enterprise(id,name,name_norm,uscc_norm) values(1,'Alpha','Alpha','91330200712345678A')")
    const {relations,...metadata}=q
    drizzle(old,{schema}).insert(schema.platformQuery).values({...metadata,id:91}).run()
    drizzle(old,{schema}).insert(schema.platformRelation).values({id:101,queryId:91,sequenceNo:1,relationKey:'NORMAL',nameRaw:'Alpha',usccRaw:'91330200712345678A',rawFields:relations![0]!.rawFields}).run()
  })
  const target=new Database(fixture.target,{verbose:q=>trace.push(String(q))});target.pragma('foreign_keys=ON')
  const migrated=drizzle(target,{schema})
  try {
    trace.length=0
    const reference={interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,reuseExisting:true as const,relations:[{sequenceNo:1}]}
    const input={...request([],`migrated-${source}`),payload:{platformQueries:[reference]}}
    const before=target.prepare('select * from platform_observation_assignment').all()
    expect(preflightRosterImport(migrated,input).preflight.conflicts).toEqual([])
    expect(commitRosterImport(migrated,input,[],{deferCandidateTasks:true})).toMatchObject({status:'committed',summary:{written:0,skipped:1}})
    expect(target.prepare('select identity_state from platform_business_observation').get()).toEqual({identity_state:'not_indexed'})
    const ordinary={...input,idempotencyKey:`bootstrap-${source}`,payload:{platformQueries:[q]}}
    expect(preflightRosterImport(migrated,ordinary).preflight.conflicts).toEqual([])
    expect(commitRosterImport(migrated,ordinary,[],{deferCandidateTasks:true})).toMatchObject({status:'committed',items:[{ref:'query:91',detail:{canonicalProjection:[{relationId:101,recordCreated:true,versionCreated:true,observationCreated:true}]}}]})
    expect(target.prepare('select identity_state from platform_business_observation').get()).toEqual({identity_state:'resolved'})
    expect(target.prepare('select * from platform_observation_assignment').all()).toEqual(before)
    expect(target.pragma('foreign_key_check')).toEqual([])
    expect(trace.filter(q=>/\b(?:from|join|into|update)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  }finally{target.close()}
})
it.each(['queryList','businessList','queryBusList'] as const)('preserves %s materialized subset references raw NULL assertions and staged conflicts without new rows', source => {
  const e=collection(source,undefined,[{id:'A',rdjb:'2',qymc:'Alpha',tyshxydm:'91330200712345678A'},{id:'B',rdjb:'2',qymc:'Alpha',tyshxydm:'91330200712345678A'}])
  const input=request([e])
  expect(commit(input).status).toBe('committed')
  const q=input.payload.platformQueries![0]!
  const reference={interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,reuseExisting:true as const,relations:[{sequenceNo:2}]}
  expect(commit({...input,idempotencyKey:'subset',payload:{platformQueries:[reference]}})).toMatchObject({status:'committed',summary:{written:0,skipped:1}})
  expect(commit({...input,idempotencyKey:'raw-null',payload:{platformQueries:[{...reference,relations:[{sequenceNo:2,rawFields:null}]}]}})).toMatchObject({status:'failed',items:[{error:{code:'observation_payload_conflict'}}]})
  expect(commit({...input,idempotencyKey:'materialized-subset',payload:{platformQueries:[{...q,relations:[q.relations![0]!]}]}})).toMatchObject({status:'failed'})
  expect(t.prepare('select count(*) n from platform_business_observation').get()).toEqual({n:2})
  noLegacy()
})
it('rejects staged payload conflicts and preflight-to-commit source changes while preserving original replay time and candidate handoff', () => {
  const q=platformResultToImport(collection('businessList'))
  const duplicate=request([], 'staged')
  duplicate.payload.platformQueries=[q,{...q,failureReason:'different assertion'}]
  expect(preflightRosterImport(db,duplicate).preflight.conflicts).toMatchObject([{error:{code:'query_payload_conflict'}}])
  expect(commit(duplicate).status).toBe('failed')
  const first=commit(request())
  expect(first.candidateTaskIds).toHaveLength(1)
  const jobs=t.prepare('select id,kind,params from job').all()
  expect(jobs).toMatchObject([{kind:'event-archive-candidates',params:expect.stringContaining('"queryId":8001')}])
  t.exec("update platform_collection set last_collected_at='2026-11-13T02:00:00Z'")
  const replay=request(undefined,'coordinate-again')
  expect(preflightRosterImport(db,replay).preflight.conflicts).toEqual([])
  expect(commit(replay).status).toBe('committed')
  expect(t.prepare('select id,kind,params from job').all()).toEqual(jobs)
  expect(t.prepare('select last_collected_at from platform_collection').get()).toEqual({last_collected_at:'2026-11-13T02:00:00Z'})
  const drift=request(undefined,'drift')
  expect(preflightRosterImport(db,drift).preflight.conflicts).toEqual([])
  t.exec("update platform_collection set status='failed'")
  expect(commit(drift)).toMatchObject({status:'failed',items:[{error:{code:'query_payload_conflict',field:'status'}}]})
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual({n:1})
  noLegacy()
})
it('retains managed102 protection and closed global runtime guards', () => {
  expect(()=>assertExpandRuntime(t)).toThrow()
  saveDecision102(db,{...scope,action:'replace',expectedCurrentId:null,idempotencyKey:'managed',actor:{type:'agent',id:'751'},basis:'explicit existing lifecycle',ruleVersion:'existing',effectiveAt:'2026-11-13T00:00:00Z',decision:{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}})
  const input=request()
  input.payload.differences=[{enterpriseName:'Alpha',titleCode:'specialized_sme',direction:'missing_in_miit',recordedAt:'2026-11-14T00:00:00Z'}]
  expect(commit(input)).toMatchObject({status:'failed',items:[{ok:true},{error:{code:'decision_lifecycle_required'}}]})
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual({n:0})
  noLegacy()
})
it.each(['queryList','businessList'] as const)('deduplicates ordinary staged %s collections and resolves the sequence-key alias without widening admission', source=>{
  const q=platformResultToImport(collection(source))
  const input=request()
  input.payload.platformQueries=[q,q]
  input.payload.aliases=[{name:'Alpha',uscc:'91330200712345678A',sourceKind:source==='queryList'?'platform_apply':'platform_business',verificationStatus:'confirmed',sourceRelationRef:{interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,sequenceNo:1,relationKey:'NORMAL'}}]
  expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
  expect(commit(input)).toMatchObject({status:'committed',summary:{written:3,skipped:1}})
  expect(t.prepare('select source_ref_id from enterprise_alias').get()).toEqual({source_ref_id:9001})
  noLegacy()
})
it.each(['queryList','businessList','queryBusList'] as const)('stores a legal partial %s page and leaves coverage incomplete', source => {
  const evidence=collection(source)
  evidence.status='partial';evidence.completeness='partial';evidence.fullRange=false
  evidence.declaredTotal=2;evidence.pages[0]!.declaredTotal=2;evidence.pages[0]!.maxPage=2;evidence.limits.pageSize=1
  evidence.unfinished=[{source,rdjb:source==='queryList'?null:'2',page:2}]
  const input=request([evidence])
  expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
  expect(commit(input)).toMatchObject({status:'committed',summary:{written:2}})
  expect(readQueryCoverage(db,scope)).toMatchObject({status:source==='queryList'?'unknown':'partial',sources:[{queryId:8001,status:'partial'}]})
  noLegacy()
})
it.each(['apply_list','business_list'] as const)('retains legacy %s NULL and omitted raw reference sentinels without adding observations', source => {
  const q={interface:source,queryKey:'91330200712345678A',rdjb:'2',queriedAt:'2026-11-13T00:00:00Z',rawResponse:'original legacy body',relations:[{sequenceNo:1,relationKey:'NULL-RAW',nameRaw:'Alpha',usccRaw:'91330200712345678A',rawFields:null}]}
  const input={...request(),payload:{platformQueries:[q]}}
  expect(commit(input)).toMatchObject({status:'committed',summary:{written:2,canonicalProjection:{unverifiable:1}}})
  for(const value of [undefined,null]){
    const {rawResponse:_raw,...ref}=q
    expect(commit({...input,idempotencyKey:`sentinel-${value}`,payload:{platformQueries:[{...ref,...(value===undefined?{}:{rawResponse:value})}]}})).toMatchObject({status:'committed',summary:{written:0,skipped:1}})
  }
  expect(t.prepare("select v.storage_class,v.bytes from platform_observation_archive_ref r join platform_archive_value v on v.id=r.archive_id where r.field='rawFields'").get()).toEqual({storage_class:'null',bytes:null})
  expect(t.prepare('select count(*) n from platform_business_observation').get()).toEqual({n:1})
  noLegacy()
})
it('preserves original schema0 import receipt requestHash and history JSON bytes across migration and subsequent collection imports', async () => {
  const history=(connection:Database.Database)=>({
    batch:connection.prepare("select id,hex(preflight_result) p,hex(item_results) i,hex(summary) s from import_batch where idempotency_key='historical751'").all(),
    receipt:connection.prepare("select id,request_hash,hex(request_body) b,hex(item_results) i,hex(summary) s from import_receipt order by id").all(),
    revision:connection.prepare('select id,source_key,source_version,coverage_digest,fact_digest from evidence_revision_113 order by id').all(),
  })
  let original:ReturnType<typeof history>|undefined
  const fixture=await targetFixture(old=>{
    old.exec("insert into enterprise(id,name,name_norm,uscc_norm) values(1,'Alpha','Alpha','91330200712345678A')")
    const database=drizzle(old,{schema}),input=request([collection('businessList')],'historical751')
    preflightRosterImport(database,input)
    expect(commitRosterImport(database,input,[],{deferCandidateTasks:true}).status).toBe('committed')
    original=history(old)
  })
  const target=new Database(fixture.target);target.pragma('foreign_keys=ON')
  try {
    const database=drizzle(target,{schema})
    expect(history(target)).toEqual(original)
    const before=history(target)
    expect(commitRosterImport(database,request([collection('businessList','2026-11-14T00:00:00Z')],'new-after-migration'),[],{deferCandidateTasks:true}).status).toBe('committed')
    const after=history(target)
    expect(after.batch).toEqual(before.batch)
    expect(after.receipt.slice(0,before.receipt.length)).toEqual(before.receipt)
    expect(after.revision.slice(0,before.revision.length)).toEqual(before.revision)
    expect(target.pragma('foreign_key_check')).toEqual([])
  }finally{target.close()}
})
it.each([
  ...(['queryList','businessList','queryBusList'] as const).flatMap(source => (['complete','partial','failed'] as const).map(state => [source,state] as const)),
  ['businessList','unknown'] as const,
])('imports %s %s empty coverage without promoting missing facts into no_record', (source,state) => {
  const evidence = collection(source, undefined, [])
  const unfinished = { source, rdjb: source === 'queryList' ? null : '2', page: 1 }
  if (state === 'partial') { evidence.status = 'partial'; evidence.completeness = 'partial'; evidence.fullRange = false; evidence.pages = []; evidence.declaredTotal = null; evidence.unfinished = [unfinished] }
  if (state === 'failed') { evidence.status = 'failed'; evidence.completeness = 'partial'; evidence.fullRange = false; evidence.pages[0]!.status = 'failed'; evidence.pages[0]!.error = { code: 'upstream_failed', message: 'ordinary failure' }; evidence.unfinished = [unfinished] }
  const input = request([evidence])
  if (state === 'unknown') input.payload.platformQueries = [{ interface: 'business_list', queryKey: '91330200712345678A', rdjb: '2', queriedAt: evidence.queriedAt, status: 'no_record', rawResponse: 'original legacy response', relations: [] }]
  expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
  expect(commit(input)).toMatchObject({ status: 'committed', summary: { written: 1 } })
  const coverage = readQueryCoverage(db,scope)
  expect(coverage.status).toBe(source === 'queryList' ? 'unknown' : state)
  expect(coverage.sources[0]?.status).toBe(state)
  expect(coverage.sources[0]).toMatchObject({ queryId: 8001, outcome: state === 'complete' ? 'no_record' : 'unknown' })
  expect(readEvidenceToken113(db,scope).latestRevisionId).toBeGreaterThan(0)
  noLegacy()
})
it.each(['queryList','businessList','queryBusList'] as const)('matches the independent schema0 %s service for public results counts previews and original 113 digests', source => {
  const path = join(f.root, `oracle-${serial}.sqlite`); copyFileSync(f.legacySource,path)
  const legacy = new Database(path); const old = drizzle(legacy,{schema})
  try {
    legacy.exec("insert into sqlite_sequence(name,seq) values('platform_query',8000),('platform_relation',9000)")
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime('2026-11-13T00:00:00Z')
    const input = request([collection(source)])
    expect(preflightRosterImport(db,input)).toEqual(preflightRosterImport(old,input))
    const actual = commit(input), expected = commitRosterImport(old,input,[],{deferCandidateTasks:true})
    expect(actual.status).toBe('committed'); expect(expected.status).toBe('committed')
    expect(actual.summary).toEqual(expected.summary)
    // The hash algorithms preserve their own evidence bases; public IDs and flags agree.
    const publicItems = (items: typeof actual.items) => items.map(item => ({ ...item, detail: item.detail ? { ...item.detail, canonicalProjection: Array.isArray(item.detail.canonicalProjection) ? item.detail.canonicalProjection.map(p => { const { inputFingerprint: _fingerprint, ...publicProjection } = p; return publicProjection }) : undefined } : undefined }))
    expect(publicItems(actual.items)).toEqual(publicItems(expected.items))
    expect(preflightRosterImport(db,{...input,idempotencyKey:'again'})).toEqual(preflightRosterImport(old,{...input,idempotencyKey:'again'}))
    expect(t.prepare('select * from evidence_revision_113').all()).toEqual(legacy.prepare('select * from evidence_revision_113').all())
    expect(t.prepare('select request_hash,request_body from import_receipt').all()).toEqual(legacy.prepare('select request_hash,request_body from import_receipt').all())
    noLegacy()
  } finally { legacy.close() }
})
it('creates an enterprise then imports three sources and resolves platform aliases and a decision in the same transaction', () => {
  const input = request(['queryList','businessList','queryBusList'].map(source => collection(source as PlatformLiveQueryResult['source'],undefined,[{id:'NEW',rdjb:'2',qymc:'New',tyshxydm:'91330211255994457P'}])))
  input.payload.announcement = { sourceDocument: { source: 'jxj', title: 'synthetic' }, records: [{ enterprise: { name: 'New', uscc: '91330211255994457P' }, titleCode: 'specialized_sme', source: 'jxj', events: [{ eventType:'award',year:2024,batchSeq:1 }] }] }
  const ref = (index: number) => { const q=input.payload.platformQueries![index]!;return { interface:q.interface, queryKey:q.queryKey, rdjb:q.rdjb, queriedAt:q.queriedAt, sequenceNo:1, relationKey:'NEW' } }
  input.payload.aliases = [{ name:'New',uscc:'91330211255994457P',sourceKind:'platform_apply',sourceRelationRef:ref(0),verificationStatus:'confirmed' }, {name:'New',uscc:'91330211255994457P',sourceKind:'platform_business',sourceRelationRef:ref(1),verificationStatus:'confirmed'}]
  input.payload.differences = [{ enterpriseName:'New',uscc:'91330211255994457P',titleCode:'specialized_sme',direction:'missing_in_miit',recordedAt:'2026-11-13T01:00:00Z',evidenceQueryRef:ref(2),evidenceRelationRef:ref(2) }]
  expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
  const result=commit(input)
  expect(result).toMatchObject({status:'committed'})
  expect(t.prepare("select enterprise_id,source_ref_id from enterprise_alias where source_kind like 'platform_%' order by id").all()).toEqual([{enterprise_id:3,source_ref_id:9001},{enterprise_id:3,source_ref_id:9002}])
  expect(t.prepare('select enterprise_id,revision from platform_observation_assignment').all()).toEqual([{enterprise_id:3,revision:1},{enterprise_id:3,revision:1},{enterprise_id:3,revision:1}])
  const decision=z.object({id:z.number()}).parse(t.prepare('select id from difference_reason').get())
  expect(readDecision102(db,decision.id)).toMatchObject({enterpriseId:3,evidenceQueryId:8003,evidenceRelationId:9003})
  noLegacy()
})
function rollbackRows() {
  return Object.fromEntries(['enterprise','platform_collection','platform_business_record','platform_business_record_version','platform_business_observation','platform_observation_assignment','evidence_revision_113','enterprise_alias','difference_reason'].map(name=>[name,t.prepare(`select count(*) n from ${name}`).get()]))
}
it.each(['later-business','capture','receipt'] as const)('rolls back %s failure at the actual caller transaction and retries without a partial business receipt', failure => {
  const input = request()
  input.payload.announcement = { sourceDocument:{source:'jxj',title:'rollback'},records:[{enterprise:{name:'New',uscc:'91330211255994457P'},titleCode:'specialized_sme',source:'jxj',events:[{eventType:'award',year:2024,batchSeq:1}]}] }
  input.payload.aliases = [{ name:'Alpha',uscc:'91330200712345678A',sourceKind:'platform_business',sourceRelationRef:{interface:'business_list',queryKey:'91330200712345678A',rdjb:'2',queriedAt:'2026-11-13T00:00:00Z',sequenceNo:1},verificationStatus:'confirmed' }]
  const before=rollbackRows()
  const trigger = failure === 'later-business' ? "before insert on enterprise_alias" : failure === 'capture' ? "before insert on evidence_revision_113" : "before update of status on import_receipt when new.status='committed'"
  t.exec(`create trigger fail751 ${trigger} begin select raise(abort,'ordinary injected failure'); end`)
  if(failure==='receipt') expect(()=>commit(input)).toThrow('ordinary injected failure')
  else expect(commit(input)).toMatchObject({status:'failed',summary:{written:0}})
  expect(rollbackRows()).toEqual(before)
  expect(t.prepare("select count(*) n from import_batch where status='committed'").get()).toEqual({n:0})
  expect(t.prepare("select count(*) n from import_receipt where status='committed'").get()).toEqual({n:0})
  expect(t.prepare("select count(*) n from import_receipt where status='failed'").get()).toEqual({n:1})
  t.exec('drop trigger fail751')
  const retried=commit(input)
  expect(retried).toMatchObject({status:'committed'})
  expect(retried.summary.written).toBeGreaterThan(3)
  expect(commit(input)).toEqual(retried)
  expect(t.prepare('select count(*) n from platform_business_observation').get()).toEqual({n:1})
  expect(t.prepare('select count(*) n from evidence_revision_113').get()).toEqual({n:3})
  noLegacy()
})
it('runs actual H3 and MCP import handlers and public source decision and 113 readback on the same injected target database', async () => {
  for(const key of ['defineEventHandler','getMethod','readBody','getHeader','setResponseStatus','setHeader','getQuery','getRouterParam','createError'] as const) vi.stubGlobal(key,h3[key])
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'synthetic-751',mcpToken:'synthetic-751',filesDir:undefined}))
  // The existing explicit service seam; global executor/worker registration remains UNRUN.
  vi.spyOn(importExecutor,'execute').mockImplementation(async(database,action,input,errors,context)=>action==='preflight'?preflightRosterImport(database,input,errors,context):commitRosterImport(database,input,errors,{...context,deferCandidateTasks:true}))
  const router=createRouter()
  for(const action of ['preflight','commit','replay'] as const)router.post(`/api/roster/import/${action}`,createRosterImportHandler(action))
  router.get('/api/platform/recognized-directory',(await import('../server/api/platform/recognized-directory.get')).default)
  router.get('/api/platform/recognized-directory/:recordId',(await import('../server/api/platform/recognized-directory/[recordId].get')).default)
  const {decisionRoute102}=await import('../server/utils/decision-lifecycle-102-route')
  router.get('/api/roster/decision-lifecycle/current',decisionRoute102('current'))
  const {reviewRoute114}=await import('../server/utils/evidence-review-114-route')
  router.get('/api/roster/evidence-impacts/:id',reviewRoute114('get'))
  const server=createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw new Error('Expected local HTTP port')
  const base=`http://127.0.0.1:${address.port}`
  const input=request([collection('queryBusList')])
  const q=input.payload.platformQueries![0]!
  input.payload.differences=[{enterpriseName:'Alpha',uscc:'91330200712345678A',titleCode:'specialized_sme',direction:'missing_in_miit',recordedAt:'2026-11-13T01:00:00Z',evidenceQueryRef:{interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt}}]
  const post=async(action:string)=>{
    const response=await fetch(`${base}/api/roster/import/${action}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-751'},body:JSON.stringify(input)})
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    expect(await post('preflight')).toMatchObject({status:'preflight',preflight:{conflicts:[]}})
    expect(await post('commit')).toMatchObject({status:'committed'})
    expect(await post('replay')).toMatchObject({status:'replayed',update:0})
    const read=(await import('../server/mcp/tools/list_platform_recognized_directory')).default
    const {recognizedDirectoryFilterSchema}=await import('../lib/platform/recognized-directory')
    const httpSource=await(await fetch(`${base}/api/platform/recognized-directory`)).json()
    const readInput={q:undefined,enterpriseId:undefined,titleRaw:undefined,platformKey:undefined,rdjb:undefined,rddqrq:undefined,whpcyear:undefined,whpc:undefined,szq:undefined,...recognizedDirectoryFilterSchema.parse({})}
    expect(z.object({structuredContent:z.unknown()}).parse(await read.handler(readInput,{} as never)).structuredContent).toEqual(httpSource)
    expect(httpSource).toMatchObject({total:1,rows:[{record:{id:1,platformKey:'NORMAL'}}]})
    const detail=await(await fetch(`${base}/api/platform/recognized-directory/1`)).json()
    const mcpDetail=(await import('../server/mcp/tools/get_platform_recognized_record')).default
    expect(z.object({structuredContent:z.unknown()}).parse(await mcpDetail.handler({recordId:1},{} as never)).structuredContent).toEqual(detail)
    expect(detail).toMatchObject({observations:[{queryId:8001,relationId:9001,enterpriseId:1}]})
    const decision=await(await fetch(`${base}/api/roster/decision-lifecycle/current?enterpriseId=1&titleCode=specialized_sme&direction=missing_in_miit`)).json()
    const mcpDecision=(await import('../server/mcp/tools/get_current_difference_decision')).default
    expect(await mcpDecision.handler(scope,{} as never)).toEqual(decision)
    expect(decision).toMatchObject({current:{evidenceQueryId:8001}})
    expect(readEvidenceToken113(db,scope)).toMatchObject({latestRevisionId:1})
    const preflight=(await import('../server/mcp/tools/preflight_roster_batch')).default
    const save=(await import('../server/mcp/tools/save_roster_batch')).default
    const nextRequest=request([collection('businessList','2026-11-14T00:00:00Z')],'mcp')
    const next={...nextRequest,sourceSha256:undefined,payload:{...nextRequest.payload}}
    expect(await preflight.handler(next,{} as never)).toMatchObject({status:'preflight',preflight:{conflicts:[]}})
    const saved=await save.handler(next,{} as never)
    expect(saved).toMatchObject({status:'committed'})
    expect(await save.handler(next,{} as never)).toEqual(saved)
    expect(readEvidenceToken113(db,scope).latestRevisionId).toBeGreaterThan(1)
    processEvidenceImpacts113(db,{limit:100})
    const impact=listImpacts114(db,impactList114.parse(scope)).rows[0]
    expect(impact).toBeDefined()
    const publicImpact=await(await fetch(`${base}/api/roster/evidence-impacts/${impact!.id}`)).json()
    const mcpImpact=(await import('../server/mcp/tools/get_evidence_impact')).default
    expect(await mcpImpact.handler({id:impact!.id},{} as never)).toEqual(publicImpact)
    expect(publicImpact).toMatchObject({evidenceToken:{latestRevisionId:2},queryCoverage:{sources:expect.arrayContaining([expect.objectContaining({queryId:8002})])}})
    noLegacy()
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})
it.each(['owner','title','pair','page','key'] as const)('rejects ordinary %s reference mismatch without committing source rows', wrong => {
  const e=collection('queryBusList')
  if(wrong==='page'){
    e.titleScope={mode:'selected',rdjb:['1','2']}
    e.pages=[{...e.pages[0]!,rdjb:'1'}, {...e.pages[0]!,rdjb:'2',fetchedCount:0,declaredTotal:0}]
  }
  const input=request([e])
  const q=input.payload.platformQueries![0]!
  const ref={interface:q.interface,queryKey:q.queryKey,rdjb:q.rdjb,queriedAt:q.queriedAt,sequenceNo:1,relationKey:wrong==='key'?'OTHER':'NORMAL'}
  if(wrong==='pair')input.payload.platformQueries!.push(platformResultToImport(collection('queryBusList','2026-11-14T00:00:00Z')))
  input.payload.differences=[{enterpriseName:wrong==='owner'?'Beta':'Alpha',uscc:wrong==='owner'?'91330200712345678B':'91330200712345678A',titleCode:wrong==='title'?'little_giant':'specialized_sme',direction:'missing_in_miit',recordedAt:'2026-11-13T01:00:00Z',evidenceQueryRef:wrong==='pair'?{...ref,queriedAt:'2026-11-14T00:00:00Z'}:ref,evidenceRelationRef:ref}]
  expect(preflightRosterImport(db,input).preflight.conflicts).toMatchObject([{error:{code:wrong==='key'?'relation_ref_not_found':'evidence_subject_mismatch'}}])
  expect(commit(input)).toMatchObject({status:'failed'})
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual({n:0})
  noLegacy()
})
it.each(['queryList','businessList','queryBusList'] as const)('imports %s through public preflight commit and replay with independent literal counts and target aliases', source => {
  const input = request([collection(source)])
  const preflight = preflightRosterImport(db,input)
  expect(preflight.preflight.conflicts).toEqual([])
  expect(preflight.preflight).toMatchObject({ add: 1, canonicalProjection: [{ relationId: null, identityState: 'resolved', contentState: 'verified' }] })
  const result = commit(input)
  expect(result).toMatchObject({ status: 'committed', summary: { written: 2, skipped: 0, failed: 0, canonicalProjection: { recordsCreated: 1, versionsCreated: 1, observationsCreated: 1 } }, items: [{ ok: true, ref: 'query:8001', detail: { relations: [9001], rowsWritten: 2 } }] })
  expect(commit(input)).toEqual(result)
  expect(replayRosterImport(db,input)).toMatchObject({ status: 'replayed', update: 0, evidenceRepointed: 0 })
  expect(t.prepare('select id from platform_collection').get()).toEqual({ id: 1 })
  expect(t.prepare('select id,collection_id,sequence_no from platform_business_observation').get()).toEqual({ id: 1, collection_id: 1, sequence_no: 1 })
  expect(t.prepare('select enterprise_id,revision from platform_observation_assignment').get()).toEqual({ enterprise_id: 1, revision: 1 })
  expect(t.prepare('select batch_id from platform_business_observation').get()).toEqual({batch_id:result.batchId})
  expect(t.prepare('select source_key,source_version from evidence_revision_113').get()).toMatchObject({ source_version: '8001:9001' })
  const archived=z.object({data:z.string()}).parse(readTargetPlatformEvidence(drizzle(t,{schema:targetSchema}),{queryId:8001,field:'collectionEvidence'}))
  expect(Buffer.from(archived.data,'base64').toString()).toBe(JSON.stringify(input.payload.platformQueries![0]!.collectionEvidence))
  noLegacy()
})
