import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { createServer } from 'node:http'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { assertExpandRuntime } from '../db/schema-phase'
import { targetRecordCorrespondence } from '../lib/platform/correspondence-target'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { writeCollectionTarget } from '../lib/platform/collection-target-replay'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import { currentDecision102, decisionCommand102, historyDecision102, readDecision102, saveDecision102 as saveRawDecision102, type DecisionCommand102 } from '../server/utils/decision-lifecycle-102'
import { z } from 'zod'
import { captureQueryRevision113, readEvidenceToken113 } from '../server/utils/evidence-impact-113'
import { closeReviewSnapshots114, getImpact114, impactList114, listImpacts114, previewImpacts114, impactPreview114, work114 } from '../server/utils/evidence-review-114'
import { refreshEnterpriseDifferences, readEnterpriseDifferenceComparisons } from '../server/utils/enterprise-difference-refresh'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { readQueryCoverage } from '../lib/roster/query-assessment'
import { readQueryAssessment } from '../lib/roster/query-assessment'
import { listSources114, impactSources114, ruleCommand114 } from '../server/utils/evidence-review-114'
import { listEvents114, impactEvents114 } from '../server/utils/evidence-review-114'
import { captureIdentityRevision113, evidenceDigest113, processEvidenceImpacts113 } from '../server/utils/evidence-impact-113'
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
vi.mock('@db', () => ({ useDb: () => db }))

const scope = { enterpriseId: 1, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
let f: Awaited<ReturnType<typeof witnessReaderFixture>>, t: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
const trace: string[] = []
let serial = 0
beforeAll(async () => {
  f = await witnessReaderFixture(old => {
    old.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha','91330200712345678A'),(2,'Beta','Beta','91330200712345678B')")
  })
  f.close()
  const p = join(f.root, 'fixed-71609.sqlite'); copyFileSync(f.target, p)
  finalizeProcessStored({ source: p, target: f.target, runId: 'process750', predecessorRunId: 'witness', legacySource: f.legacySource })
  const c = join(f.root, 'fixed-71610.sqlite'); copyFileSync(f.target, c)
  transferCorrespondence({ source: c, target: f.target, runId: 'correspondence750' })
  const d = join(f.root, 'fixed-71611.sqlite'); copyFileSync(f.target, d)
  transferDifferenceReferences({ source: d, target: f.target, runId: 'difference750' })
})
beforeEach(() => {
  const path = join(f.root, `case-${++serial}.sqlite`); copyFileSync(f.target, path)
  t = new Database(path, { verbose: q => trace.push(String(q)) }); t.pragma('foreign_keys=ON')
  t.pragma('journal_mode=WAL')
  db = drizzle(t, { schema }); trace.length = 0
  reserveLegacyIds(drizzle(t, { schema: targetSchema }), { query: 8000, relation: 9000 })
})
import { afterEach } from 'vitest'
afterEach(() => { closeReviewSnapshots114(); t?.close() })
afterAll(() => vi.unstubAllGlobals())
function collection(time = '2026-11-13T00:00:00Z', rows: Record<string, string>[] = [{ id: 'NORMAL', rdjb: '2', qymc: 'Alpha', tyshxydm: '91330200712345678A', cszt: '终审通过', year: '2024', sblx: '申请' }]): PlatformLiveQueryResult {
  return { source: 'businessList', status: rows.length ? 'success' : 'no_record', effectiveConditions: { uscc: '91330200712345678A', combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: time, completedAt: time, rows, dataRows: rows,
    pages: [{ source: 'businessList', rdjb: '2', page: 1, maxPage: 1, declaredTotal: rows.length, fetchedCount: rows.length, status: 'success', error: null }],
    fetchedCount: rows.length, declaredTotal: rows.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 } }
}
function submit(evidence = collection()) {
  const query = platformResultToImport(evidence)
  return writeCollectionTarget(drizzle(t, { schema: targetSchema }), { queryText: JSON.stringify(query), evidenceText: JSON.stringify(evidence), createdAt: evidence.queriedAt,
    assignments: (query.relations ?? []).map(() => ({ enterpriseId: 1, nameRaw: 'Alpha', usccRaw: '91330200712345678A', matchBasis: 'uscc', verificationStatus: 'confirmed', origin: 'command', actor: { type: 'agent', id: '750' }, basis: 'normal source verified' })) })
}
function command(key: string, decision: DecisionCommand102['decision'], expectedCurrentId: number | null = null): DecisionCommand102 {
  return { ...scope, action: 'replace', expectedCurrentId, idempotencyKey: key, actor: { type: 'agent', id: '750' }, basis: 'normal checked', ruleVersion: 'existing', effectiveAt: '2026-11-13T00:00:00Z', decision }
}
const receiptSchema=z.object({versionId:z.number(),currentId:z.number().nullable(),previousId:z.number().nullable(),action:z.string().nullable(),recordedAt:z.string(),reviewedRevisionId:z.number().optional()}).passthrough()
function saveDecision102(database: typeof db,input:DecisionCommand102) {
  return receiptSchema.parse(saveRawDecision102(database,input))
}
function legacySource(database: ReturnType<typeof drizzle<typeof schema>>, evidence: PlatformLiveQueryResult, queryId: number, relationId: number) {
  const { relations, ...query } = platformResultToImport(evidence)
  database.insert(schema.platformQuery).values({ ...query, id: queryId, collectionEvidence: evidence }).run()
  for (const [index, row] of (relations ?? []).entries()) {
    const normalized=normalizePlatformRelation(query.interface,row)
    database.insert(schema.platformRelation).values({ ...normalized, declareKind:z.enum(['apply','review','update']).nullable().parse(normalized.declareKind ?? null), id: relationId + index, queryId, enterpriseId: 1, nameRaw: 'Alpha', usccRaw: '91330200712345678A', matchBasis: 'uscc', verificationStatus: 'confirmed' }).run()
    ensurePlatformObservation(database, relationId + index)
  }
}
it('saves paired external aliases once to physical FKs and replays replaces withdraws with unchanged public history', () => {
  const source = submit(), row = source.observations[0]!
  expect(source.queryAlias).toBe(8001); expect(row.relationAlias).toBe(9001)
  expect(source.collectionId).not.toBe(source.queryAlias); expect(row.observationId).not.toBe(row.relationAlias)
  trace.length = 0
  const input = command('paired', { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending', evidenceQueryId: 8001, evidenceRelationId: 9001 })
  const saved = saveDecision102(db, input)
  expect(saveDecision102(db, input)).toEqual(saved)
  expect(readDecision102(db, saved.versionId)).toMatchObject({ evidenceQueryId: 8001, evidenceRelationId: 9001, previousId: null })
  expect(t.prepare('select evidence_query_id q,evidence_relation_id r from difference_reason').get()).toEqual({ q: source.collectionId, r: row.observationId })
  const replaced = saveDecision102(db, command('query-only', { ...input.decision!, evidenceRelationId: null }, saved.versionId))
  expect(readDecision102(db, replaced.versionId)).toMatchObject({ previousId: saved.versionId, evidenceQueryId: 8001, evidenceRelationId: null })
  const withdrawn = saveDecision102(db, { ...input, action: 'withdraw', decision: undefined, idempotencyKey: 'withdraw', expectedCurrentId: replaced.versionId })
  expect(currentDecision102(db, scope)).toMatchObject({ versionId: withdrawn.versionId, current: null })
  expect(historyDecision102(db, { ...scope, page: 1, pageSize: 50 }).rows.map(r => r.evidenceQueryId)).toEqual([null,8001,8001])
  expect(trace.filter(q => /\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  expect(t.pragma('foreign_key_check')).toEqual([])
})
it('captures a committed target revision then previews processes reads and authorizes maintain without duplicating audit', () => {
  const saved = saveDecision102(db, command('before-query', { status: 'not_queried', measureCode: 'manual_review', verificationStatus: 'pending' }))
  const source = db.transaction(tx => {
    const written = submit()
    captureQueryRevision113(tx, written.queryAlias)
    return written
  })
  expect(readEvidenceToken113(db, scope)).toMatchObject({ decisionId: saved.versionId, latestRevisionId: 1, projectionReady: false })
  const preview = previewImpacts114(db, impactPreview114.parse({ revisionId: 1 }))
  expect(preview.rows).toMatchObject([{ id: saved.versionId, classification: 'premise_invalid' }])
  const process = { action: 'process' as const, limit: 100, idempotencyKey: 'process', actor: { type: 'agent' as const, id: '750' }, basis: 'drain committed work' }
  const receipt = work114(db, process)
  expect(work114(db, process)).toEqual(receipt)
  const list = listImpacts114(db, impactList114.parse(scope))
  expect(list.rows).toMatchObject([{ decisionId: saved.versionId, classification: 'premise_invalid', pending: true }])
  const detail = getImpact114(db, list.rows[0]!.id)
  expect(detail.queryCoverage).toMatchObject({ status: 'complete', sources: [{ queryId: source.queryAlias, status: 'complete', subjectMatch: 'exact_uscc', outcome: 'records' }] })
  const review = { ...command('maintain', undefined, saved.versionId), action: 'maintain' as const, reviewedEvidence: { latestRevisionId: 1, projectionReady: true as const } }
  expect(saveDecision102(db, review)).toMatchObject({ versionId: saved.versionId, action: 'maintain', reviewedRevisionId: 1 })
  const maintained = saveDecision102(db, review)
  expect(saveDecision102(db, review)).toEqual(maintained)
  expect(getImpact114(db, list.rows[0]!.id)).toMatchObject({ pending: false, reviewedBaseline: { reviewedRevisionId: 1 } })
  expect(t.prepare('select count(*) n from difference_reason').get()).toEqual({ n: 1 })
  expect(t.prepare('select count(*) n from evidence_review_receipt_114').get()).toEqual({ n: 2 })
  expect(trace.filter(q => /\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
})
it('refreshes all titles then retains unchanged fingerprints and reads fresh source changes without old table reads', () => {
  submit()
  trace.length = 0
  const first = refreshEnterpriseDifferences(db, { enterpriseIds: [1] }, '2026-11-13T01:00:00Z')
  expect(first).toMatchObject({ refreshed: 3, unchanged: 0 })
  expect(first.enterprises[0]!.comparisons.every(c=>c.comparisonState==='not_established')).toBe(true)
  const judgment=saveDecision102(db,command('fresh-judgment',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'}))
  expect(readEnterpriseDifferenceComparisons(db,{enterpriseIds:[1]}).enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')?.status).toBe('confirmed_no_diff')
  const again = refreshEnterpriseDifferences(db, { enterpriseIds: [1] }, '2026-11-13T02:00:00Z')
  expect(again).toMatchObject({ refreshed: 0, unchanged: 3 })
  submit(collection('2026-11-13T03:00:00Z', []))
  const changed = refreshEnterpriseDifferences(db, { enterpriseIds: [1] }, '2026-11-13T04:00:00Z')
  expect(changed).toMatchObject({ refreshed: 1, unchanged: 2 })
  expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')?.status).toBe('needs_review')
  expect(readDecision102(db,judgment.versionId)).toMatchObject({status:'confirmed_no_diff'})
  expect(trace.filter(q => /\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
})
it('retains old normal revision envelopes digests source versions and business fingerprints against the schema0 service', () => {
  const path = join(f.root, 'oracle-750.sqlite'); copyFileSync(f.legacySource, path)
  const legacy = new Database(path), old = drizzle(legacy, { schema })
  try {
    const evidence = collection(), source = submit(evidence)
    legacySource(old,evidence,source.queryAlias,source.observations[0]!.relationAlias)
    const input = command('oracle', { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed', evidenceQueryId: source.queryAlias, evidenceRelationId: source.observations[0]!.relationAlias })
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime('2026-11-13T00:00:00Z')
    expect(saveDecision102(db,input)).toEqual(saveDecision102(old,input))
    captureQueryRevision113(db,source.queryAlias); captureQueryRevision113(old,source.queryAlias)
    expect(t.prepare('select * from evidence_revision_113').all()).toEqual(legacy.prepare('select * from evidence_revision_113').all())
    expect(t.prepare('select request_hash,idempotency_key,actor,basis from difference_reason').all()).toEqual(legacy.prepare('select request_hash,idempotency_key,actor,basis from difference_reason').all())
    const targetRefresh = refreshEnterpriseDifferences(db,{enterpriseIds:[1]},'2026-11-13T01:00:00Z')
    const oldRefresh = refreshEnterpriseDifferences(old,{enterpriseIds:[1]},'2026-11-13T01:00:00Z')
    expect(targetRefresh.enterprises[0]!.comparisons.map(r=>r.businessFingerprint)).toEqual(oldRefresh.enterprises[0]!.comparisons.map(r=>r.businessFingerprint))
    expect(readQueryCoverage(db,scope)).toEqual(readQueryCoverage(old,scope))
  } finally { vi.useRealTimers(); legacy.close() }
})
it.each(['queryList','businessList','queryBusList'] as const)('preserves the old refresh hash after an ordinary second content version with the same business values for %s', source => {
  const path=join(f.root,'second-version-oracle.sqlite');copyFileSync(f.legacySource,path)
  const legacy=new Database(path),old=drizzle(legacy,{schema})
  try {
    let initial: ReturnType<typeof refreshEnterpriseDifferences> | undefined
    for(const [index,time] of ['2026-11-13T00:00:00Z','2026-11-13T01:00:00Z'].entries()) {
      const evidence=collection(time)
      evidence.source=source; evidence.pages[0]!.source=source
      if(source==='queryList') {evidence.titleScope={mode:'source_default',rdjb:[]};evidence.pages[0]!.rdjb=null;evidence.effectiveConditions={name:'Alpha',combination:'and'}}
      evidence.rows[0]!.transportAnnotation=String(index)
      evidence.dataRows=evidence.rows
      const written=submit(evidence)
      legacySource(old,evidence,written.queryAlias,written.observations[0]!.relationAlias)
      if(index===0) {
        initial=refreshEnterpriseDifferences(db,{enterpriseIds:[1]},'2026-11-13T00:30:00Z')
        saveDecision102(db,command('stable-refresh',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'}))
      }
    }
    const actual=refreshEnterpriseDifferences(db,{enterpriseIds:[1]},'2026-11-13T02:00:00Z')
    const expected=refreshEnterpriseDifferences(old,{enterpriseIds:[1]},'2026-11-13T02:00:00Z')
    expect(actual.enterprises[0]!.comparisons.map(c=>c.businessFingerprint)).toEqual(expected.enterprises[0]!.comparisons.map(c=>c.businessFingerprint))
    expect(actual.enterprises[0]!.comparisons.map(c=>c.businessFingerprint)).toEqual(initial?.enterprises[0]!.comparisons.map(c=>c.businessFingerprint))
    expect(actual).toMatchObject({refreshed:0,unchanged:3})
    expect(actual.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')?.status).toBe('confirmed_no_diff')
    // Independently obtained with the unmodified 49f31949 refresh algorithm and
    // its original projection column layout, before the 0050 expansion.
    if(source==='businessList') expect(actual.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')?.businessFingerprint).toBe('badcaf0f9435f92a12a391981aba09dc3b50a426e306aef464c20c8585351025')
    const changed=collection('2026-11-13T03:00:00Z')
    changed.source=source; changed.pages[0]!.source=source
    if(source==='queryList') {changed.titleScope={mode:'source_default',rdjb:[]};changed.pages[0]!.rdjb=null;changed.effectiveConditions={name:'Alpha',combination:'and'}}
    changed.rows[0]!.cszt='已退回'; changed.rows[0]!.whpc='2025-2'
    changed.dataRows=changed.rows
    submit(changed)
    const refreshed=refreshEnterpriseDifferences(db,{enterpriseIds:[1]},'2026-11-13T04:00:00Z')
    expect(refreshed).toMatchObject(source==='queryList'?{refreshed:3,unchanged:0}:{refreshed:1,unchanged:2})
    expect(refreshed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')?.status).toBe('needs_review')
    expect(trace.filter(q => /\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  } finally {legacy.close()}
})
it('keeps query-only relation-only confirmed identity and successful multi-title page validation stricter than candidate scope', () => {
  const evidence = collection()
  evidence.source = 'queryBusList'; evidence.pages[0]!.source = 'queryBusList'
  evidence.titleScope.rdjb = ['2','3']
  evidence.rows = [...evidence.rows,{id:'GIANT',rdjb:'3',qymc:'Alpha',tyshxydm:'91330200712345678A'}]; evidence.dataRows=evidence.rows
  evidence.fetchedCount=2; evidence.declaredTotal=2
  evidence.pages=[evidence.pages[0]!,{...evidence.pages[0]!,rdjb:'3'}]
  const source=submit(evidence),first=source.observations[0]!,second=source.observations[1]!
  const decision={status:'confirmed_reason' as const,reasonCode:'moved_in' as const,measureCode:'manual_review' as const,verificationStatus:'confirmed' as const,evidenceRelationId:first.relationAlias}
  const saved=saveDecision102(db,command('relation-only',decision))
  expect(readDecision102(db,saved.versionId)).toMatchObject({evidenceQueryId:null,evidenceRelationId:first.relationAlias})
  expect(()=>saveDecision102(db,command('wrong-page',{...decision,evidenceRelationId:second.relationAlias},saved.versionId))).toThrow('Original row title is unknown or different')
  expect(()=>saveDecision102(db,{...command('other-owner',decision),enterpriseId:2})).toThrow('Relation evidence belongs to another or conflicting enterprise')
  const assignment=targetSchema.platformObservationAssignment
  db.insert(assignment).values({observationId:first.observationId,revision:2,enterpriseId:1,usccRaw:'91330200712345678B',nameRaw:'Corrected attribution',matchBasis:'manual',verificationStatus:'pending',origin:'command',actor:{type:'user',id:'750'},basis:'normal attribution revision',recordedAt:'2026-11-13'}).run()
  const qualification={titleCode:'specialized_sme' as const,validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z',basis:'explicit interval',publicationCheck:{status:'not_checked' as const,scope:'normal source'}}
  expect(()=>saveDecision102(db,command('pending-source',{...decision,currentQualification:qualification},saved.versionId))).toThrow('Current qualification requires an explicitly confirmed source row')
  // Mutable attribution text cannot replace the original source identity.
  const confirmed={observationId:first.observationId,revision:3,enterpriseId:1,usccRaw:'91330200712345678B',nameRaw:'Corrected attribution',matchBasis:'manual' as const,verificationStatus:'confirmed' as const,origin:'command' as const,actor:{type:'user' as const,id:'750'},basis:'verified',recordedAt:'2026-11-13'}
  db.insert(assignment).values(confirmed).run()
  expect(saveDecision102(db,command('original-identity',{...decision,currentQualification:qualification},saved.versionId))).toHaveProperty('versionId')
  db.insert(assignment).values({...confirmed,revision:4,enterpriseId:2}).run()
  expect(()=>saveDecision102(db,{...command('attributed-other',decision),enterpriseId:2})).toThrow('Relation evidence belongs to another or conflicting enterprise')
})
it('does not promote confirmed alias candidate membership to exact query-only decision evidence', () => {
  db.insert(schema.enterpriseAlias).values({enterpriseId:1,name:'Former',nameNorm:'Former',sourceKind:'manual',verificationStatus:'confirmed'}).run()
  const evidence=collection();evidence.source='queryBusList';evidence.pages[0]!.source='queryBusList';evidence.effectiveConditions={name:'Former',combination:'and'}
  const source=submit(evidence)
  const decision={status:'confirmed_no_diff' as const,measureCode:'none' as const,verificationStatus:'confirmed' as const,evidenceQueryId:source.queryAlias}
  expect(()=>saveDecision102(db,command('alias-query',decision))).toThrow('Query-only evidence must identify the exact enterprise')
  expect(saveDecision102(db,command('paired-alias',{...decision,evidenceRelationId:source.observations[0]!.relationAlias}))).toHaveProperty('versionId')
})
it.each(['complete','partial','failed','unknown'] as const)('preserves %s empty coverage and never invents no-record from a gap', state => {
  const evidence=collection('2026-11-13T00:00:00Z',[])
  if(state==='partial'){evidence.status='partial';evidence.completeness='partial';evidence.fullRange=false;evidence.pages=[];evidence.declaredTotal=null;evidence.unfinished=[{source:'businessList',rdjb:'2',page:1}]}
  if(state==='failed'){evidence.status='failed';evidence.completeness='partial';evidence.fullRange=false;evidence.pages[0]!.status='failed';evidence.pages[0]!.error={code:'upstream_failed',message:'normal failure'};evidence.unfinished=[{source:'businessList',rdjb:'2',page:1}]}
  let queryId:number
  if(state==='unknown') {
    const written=writeCollectionTarget(drizzle(t,{schema:targetSchema}),{queryText:JSON.stringify({interface:'business_list',queryKey:'91330200712345678A',rdjb:'2',queriedAt:evidence.queriedAt,status:'no_record',rawResponse:'original legacy response',relations:[]}),evidenceText:null,assignments:[],createdAt:evidence.queriedAt})
    queryId=written.queryAlias
  } else queryId=submit(evidence).queryAlias
  captureQueryRevision113(db,queryId)
  const coverage=readQueryCoverage(db,scope)
  expect(coverage.status).toBe(state)
  expect(coverage.sources[0]!.outcome).toBe(state==='complete'?'no_record':'unknown')
})
it('rejects ordinary stale decision and evidence tokens and rolls source capture back with its caller transaction', () => {
  const saved=saveDecision102(db,command('initial',{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}))
  expect(()=>saveDecision102(db,command('stale',{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}))).toThrow('Expected current version no longer matches')
  const before=t.prepare('select count(*) n from platform_collection').get()
  expect(()=>db.transaction(tx=>{const source=submit();captureQueryRevision113(tx,source.queryAlias);throw new Error('caller rollback')})).toThrow('caller rollback')
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual(before)
  expect(t.prepare('select count(*) n from evidence_revision_113').get()).toEqual({n:0})
  const source=submit();captureQueryRevision113(db,source.queryAlias)
  const maintain={...command('stale-review',undefined,saved.versionId),action:'maintain' as const,reviewedEvidence:{latestRevisionId:0,projectionReady:true as const}}
  expect(()=>saveDecision102(db,maintain)).toThrow('Relevant committed evidence changed')
  processEvidenceImpacts113(db,{limit:100})
  expect(()=>saveDecision102(db,maintain)).toThrow('Relevant committed evidence changed')
  expect(t.prepare('select count(*) n from evidence_review_receipt_114').get()).toEqual({n:0})
})
it('deduplicates same-version observations while preserving new occurrence identity and source conflict rollback', () => {
  const a=submit(),b=submit(collection('2026-11-13T01:00:00Z'))
  expect(a.observations[0]!.versionId).toBe(b.observations[0]!.versionId)
  expect(a.observations[0]!.observationId).not.toBe(b.observations[0]!.observationId)
  captureQueryRevision113(db,a.queryAlias);captureQueryRevision113(db,b.queryAlias)
  expect(t.prepare('select count(*) n from evidence_revision_113').get()).toEqual({n:1})
  const changed=collection();changed.rows[0]!.cszt='退回'
  expect(()=>submit(changed)).toThrow()
  expect(t.prepare('select count(*) n from platform_collection').get()).toEqual({n:2})
})
it('releases a scoped rule idempotently and pages immutable source revisions after explicit reviewed replacement', () => {
  const saved=saveDecision102(db,command('initial',{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}))
  for(const version of ['v1','v2']) work114(db,ruleCommand114.parse({action:'release_rule',ruleId:'existing-rule',version,idempotencyKey:version,actor:{type:'agent',id:'750'},basis:'explicit evaluated change',scopes:[{...scope,previousEvaluationDigest:evidenceDigest113('before'),evaluationDigest:evidenceDigest113(version)}]}))
  processEvidenceImpacts113(db,{limit:100})
  const row=listImpacts114(db,impactList114.parse(scope)).rows[0]!
  const first=listSources114(db,impactSources114.parse({id:row.id,limit:1}))
  expect(first.rows.map(r=>r.sourceVersion)).toEqual(['v1']);expect(first.nextCursor).toBeTruthy()
  const second=listSources114(db,impactSources114.parse({id:row.id,limit:1,cursor:first.nextCursor}))
  expect(second.rows.map(r=>r.sourceVersion)).toEqual(['v2']);expect(second.asOf).toEqual(first.asOf)
  const reviewed={...command('reviewed-replace',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'},saved.versionId),reviewedEvidence:{latestRevisionId:2,projectionReady:true as const}}
  const replacement=saveDecision102(db,reviewed)
  expect(saveDecision102(db,reviewed)).toEqual(replacement)
  expect(currentDecision102(db,scope).current).toMatchObject({id:replacement.versionId,status:'confirmed_no_diff',previousId:saved.versionId})
  expect(work114(db,{action:'process',limit:100,idempotencyKey:'reprocess',actor:{type:'agent',id:'750'},basis:'repeat drain'})).toMatchObject({processed:0,unfinished:false})
  expect(t.prepare('select count(*) n from evidence_impact_link_113').get()).toEqual({n:2})
})
it('freezes list cursor ownership and pending state across reviewed replacement and later committed revisions', () => {
  const a=saveDecision102(db,command('missing',{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}))
  saveDecision102(db,{...command('extra',{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}),direction:'extra_in_miit'})
  captureIdentityRevision113(db,{enterpriseId:1,sourceKey:'profile',sourceVersion:'1',before:'Alpha',after:'Alpha new'})
  processEvidenceImpacts113(db,{limit:100})
  const first=listImpacts114(db,impactList114.parse({enterpriseId:1,limit:1}))
  expect(first.rows).toHaveLength(1);expect(first.nextCursor).toBeTruthy()
  saveDecision102(db,{...command('reviewed',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'},a.versionId),reviewedEvidence:{latestRevisionId:1,projectionReady:true}})
  captureIdentityRevision113(db,{enterpriseId:1,sourceKey:'profile',sourceVersion:'2',before:'Alpha new',after:'Alpha newest'})
  processEvidenceImpacts113(db,{limit:100})
  const second=listImpacts114(db,impactList114.parse({enterpriseId:1,limit:1,cursor:first.nextCursor}))
  expect(second.asOf).toEqual(first.asOf)
  expect(second.rows).toMatchObject([{direction:'extra_in_miit',latestRevisionId:1,pending:true,lineage:'current'}])
  expect(()=>listImpacts114(db,impactList114.parse({enterpriseId:2,limit:1,cursor:first.nextCursor}))).toThrow('Cursor is invalid')
  expect(listImpacts114(db,impactList114.parse({enterpriseId:1})).rows.map(r=>r.latestRevisionId)).toEqual([2,2])
})
it('preserves schema0 lifecycle history request hashes and 113 114 serialized bytes through the complete migration', async () => {
  const original=command('original', {status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed',evidenceQueryId:40001,evidenceRelationId:50001})
  let version=0
  const history=await witnessReaderFixture(sqlite=>{
    const old=drizzle(sqlite,{schema})
    old.insert(schema.enterprise).values({id:1,name:'Alpha',nameNorm:'Alpha',usccNorm:'91330200712345678A'}).run()
    legacySource(old,collection(),40001,50001)
    version=saveDecision102(old,original).versionId
    captureQueryRevision113(old,40001)
    processEvidenceImpacts113(old,{limit:100})
    saveDecision102(old,{...command('original-maintain',undefined,version),action:'maintain',reviewedEvidence:{latestRevisionId:1,projectionReady:true}})
  })
  history.close()
  const p=join(history.root,'history-71609.sqlite');copyFileSync(history.target,p)
  finalizeProcessStored({source:p,target:history.target,runId:'process-history750',predecessorRunId:'witness',legacySource:history.legacySource})
  const c=join(history.root,'history-71610.sqlite');copyFileSync(history.target,c)
  transferCorrespondence({source:c,target:history.target,runId:'correspondence-history750'})
  const d=join(history.root,'history-71611.sqlite');copyFileSync(history.target,d)
  transferDifferenceReferences({source:d,target:history.target,runId:'difference-history750'})
  const old=new Database(history.legacySource,{readonly:true}),target=new Database(history.target)
  try {
    const oldDb=drizzle(old,{schema}),targetDb=drizzle(target,{schema})
    expect(readDecision102(targetDb,version)).toEqual(readDecision102(oldDb,version))
    expect(saveDecision102(targetDb,original)).toEqual({versionId:version,currentId:version,previousId:null,action:'replace',recordedAt:readDecision102(oldDb,version).recordedAt})
    for(const table of ['evidence_revision_113','evidence_semantic_head_113','evidence_scope_version_113','evidence_impact_progress_113','explanation_impact_113','evidence_impact_link_113','evidence_review_receipt_114']) {
      const columns=old.prepare(`pragma table_info(${table})`).all() as {name:string}[]
      const projection=columns.map(c=>`hex(cast("${c.name}" as blob)) AS "${c.name}"`).join(',')
      expect(target.prepare(`select ${projection} from ${table}`).all(),table).toEqual(old.prepare(`select ${projection} from ${table}`).all())
    }
    expect(target.prepare('select request_hash,idempotency_key from difference_reason').all()).toEqual(old.prepare('select request_hash,idempotency_key from difference_reason').all())
  } finally {old.close();target.close()}
})
it('runs actual REST commands and MCP handlers from capture through reviewed replacement and public readback', async () => {
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'synthetic-api-750',mcpToken:'synthetic-mcp-750'}))
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  const {decisionRoute102}=await import('../server/utils/decision-lifecycle-102-route')
  const {reviewRoute114}=await import('../server/utils/evidence-review-114-route')
  const router=createRouter()
  router.post('/api/roster/decision-lifecycle/commands',decisionRoute102('commands'))
  router.get('/api/roster/decision-lifecycle/current',decisionRoute102('current'))
  router.post('/api/roster/evidence-impacts/commands',reviewRoute114('commands'))
  router.get('/api/roster/evidence-impacts',reviewRoute114('list'))
  router.get('/api/roster/evidence-impacts/:id',reviewRoute114('get'))
  const server=createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address || typeof address==='string')throw new Error('Expected local HTTP port')
  const base=`http://127.0.0.1:${address.port}`
  const post=async(path:string,body:unknown,authorized=true)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer synthetic-api-750'}:{})},body:JSON.stringify(body)})
    expect(response.headers.get('cache-control')).toBe('no-store')
    return {status:response.status,body:await response.json()}
  }
  try {
    const initial=command('rest-initial',{status:'not_queried',measureCode:'manual_review',verificationStatus:'pending'})
    expect((await post('/api/roster/decision-lifecycle/commands',initial,false)).status).toBe(401)
    const first=await post('/api/roster/decision-lifecycle/commands',initial)
    expect(first.status).toBe(200)
    const source=db.transaction(tx=>{const source=submit();captureQueryRevision113(tx,source.queryAlias);return source})
    const processed=await post('/api/roster/evidence-impacts/commands',{action:'process',limit:100,idempotencyKey:'rest-process',actor:{type:'agent',id:'750'},basis:'explicit work'})
    expect(processed).toMatchObject({status:200,body:{unfinished:false,action:'process'}})
    const listResponse=await fetch(base+'/api/roster/evidence-impacts?enterpriseId=1')
    expect(listResponse.status).toBe(200)
    const list=await listResponse.json()
    const detail=await (await fetch(base+'/api/roster/evidence-impacts/'+list.rows[0].id)).json()
    expect(detail).toMatchObject({classification:'premise_invalid',evidenceToken:{projectionReady:true,latestRevisionId:1}})
    const save=(await import('../server/mcp/tools/save_difference_decision')).default
    const input={...command('mcp-reviewed',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed',evidenceQueryId:source.queryAlias,evidenceRelationId:source.observations[0]!.relationAlias},first.body.versionId),reviewedEvidence:{latestRevisionId:1,projectionReady:true as const}}
    const external=decisionCommand102.parse(input)
    const result=await save.handler({...external,decision:external.decision,reviewedEvidence:external.reviewedEvidence},{} as never)
    expect(result).toMatchObject({previousId:first.body.versionId,reviewedRevisionId:1})
    expect(await save.handler({...external,decision:external.decision,reviewedEvidence:external.reviewedEvidence},{} as never)).toEqual(result)
    const current=await (await fetch(base+'/api/roster/decision-lifecycle/current?enterpriseId=1&titleCode=specialized_sme&direction=missing_in_miit')).json()
    expect(current.current).toMatchObject({status:'confirmed_no_diff',evidenceQueryId:8001,evidenceRelationId:9001})
    const read=(await import('../server/mcp/tools/get_current_difference_decision')).default
    expect(await read.handler(scope,{} as never)).toEqual(current)
    expect(trace.filter(q=>/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})
it.each(['condition','page'] as const)('retains reviewed authorization for a disjoint %s partition once durable projection is ready', kind => {
  const before=collection()
  before.source='queryBusList';before.pages[0]!.source='queryBusList'
  if(kind==='condition') before.effectiveConditions.whpcyear='2024'
  else {
    before.fullRange=false;before.completeness='partial';before.status='partial'
    before.limits.pageSize=1;before.pages[0]!.maxPage=2;before.pages[0]!.declaredTotal=2;before.declaredTotal=2
    before.unfinished=[{source:'queryBusList',rdjb:'2',page:2}]
  }
  const source=submit(before)
  const saved=saveDecision102(db,command('scoped',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed',evidenceQueryId:source.queryAlias}))
  captureQueryRevision113(db,source.queryAlias);processEvidenceImpacts113(db,{limit:100})
  saveDecision102(db,{...command('baseline',undefined,saved.versionId),action:'maintain',reviewedEvidence:{latestRevisionId:1,projectionReady:true}})
  const after=collection('2026-11-13T01:00:00Z')
  after.source='queryBusList';after.pages[0]!.source='queryBusList';after.rows[0]!.cszt='退回';after.dataRows=after.rows
  if(kind==='condition')after.effectiveConditions.whpcyear='2025'
  else {after.fullRange=false;after.limits.pageSize=1;after.pages[0]!.page=2;after.pages[0]!.maxPage=2;after.pages[0]!.declaredTotal=2;after.declaredTotal=2}
  const next=submit(after);captureQueryRevision113(db,next.queryAlias)
  expect(readQueryAssessment(db,scope).explanationValidity.status).toBe('evidence_changed')
  processEvidenceImpacts113(db,{limit:100})
  expect(readQueryAssessment(db,scope).explanationValidity.status).toBe('valid')
  expect(t.prepare('select count(*) n from evidence_impact_link_113').get()).toEqual({n:1})
  expect(t.prepare('select reviewed_revision_id from evidence_review_receipt_114').get()).toEqual({reviewed_revision_id:1})
})
it('keeps the maxDecision cutoff and confirmed event dependencies on newly captured target evidence', () => {
  const source=submit()
  const old=saveDecision102(db,command('old',{status:'not_queried',measureCode:'manual_review',verificationStatus:'pending'}))
  db.insert(schema.record).values({id:1,enterpriseId:1,titleCode:'specialized_sme',source:'jxj'}).run()
  db.insert(schema.recordEvent).values({id:1,recordId:1,eventType:'award',year:2024}).run()
  // This test seeds the already accepted #745 correspondence storage seam;
  // the normal command and its proof behavior are covered in that owner's tests.
  db.insert(targetRecordCorrespondence).values({edgeKey:'normal-event750',type:'event_process',role:'supports_award',eventId:1,observationId:source.observations[0]!.observationId,enterpriseId:1,titleCode:'specialized_sme',status:'confirmed',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'source',ruleId:'manual',ruleVersion:'1',createdAt:'2026-11-13'}).run()
  captureQueryRevision113(db,source.queryAlias)
  const replacement=saveDecision102(db,command('fresh',{status:'confirmed_no_diff',measureCode:'none',verificationStatus:'confirmed'},old.versionId))
  expect(previewImpacts114(db,impactPreview114.parse({revisionId:1})).rows).toEqual([])
  processEvidenceImpacts113(db,{limit:100})
  expect(listImpacts114(db,impactList114.parse({enterpriseId:1})).rows).toEqual([])
  expect(t.prepare('select event_id,enterprise_id,title_code from evidence_revision_event_113').all()).toEqual([{event_id:1,enterprise_id:1,title_code:'specialized_sme'}])
  expect(listEvents114(db,impactEvents114.parse({revisionId:1,enterpriseId:1})).rows).toMatchObject([{revisionId:1,eventId:1,enterpriseId:1,titleCode:'specialized_sme'}])
  expect(currentDecision102(db,scope).current?.id).toBe(replacement.versionId)
})
it.each(['queryList','businessList','queryBusList'] as const)('keeps %s original typed revision hash inputs and unknown facts equal to the old normal service', kind => {
  const path=join(f.root,`typed-${kind}-oracle.sqlite`);copyFileSync(f.legacySource,path)
  const legacy=new Database(path),old=drizzle(legacy,{schema})
  try {
    const evidence=collection();evidence.source=kind;evidence.pages[0]!.source=kind
    evidence.rows[0]!.rddqrq=' 2028 ';evidence.rows[0]!.whpcyear='false';evidence.rows[0]!.whpc='0';evidence.rows[0]!.szq=''
    evidence.dataRows=[{...evidence.rows[0],whpcyear:false,whpc:0,szq:null}]
    if(kind==='queryList') {evidence.titleScope={mode:'source_default',rdjb:[]};evidence.pages[0]!.rdjb=null;evidence.effectiveConditions={name:'Alpha',combination:'and'}}
    const source=submit(evidence)
    legacySource(old,evidence,source.queryAlias,source.observations[0]!.relationAlias)
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-11-13T00:00:00Z')
    captureQueryRevision113(db,source.queryAlias);captureQueryRevision113(old,source.queryAlias)
    expect(t.prepare('select * from evidence_revision_113').all()).toEqual(legacy.prepare('select * from evidence_revision_113').all())
    expect(t.prepare('select title_code,source_version from evidence_revision_113').get()).toEqual({title_code:kind==='queryList'?null:'specialized_sme',source_version:'8001:9001'})
  } finally {vi.useRealTimers();legacy.close()}
})
it('retains existing fact-reference revision semantics and keeps the global finalized-schema guard closed', () => {
  expect(()=>assertExpandRuntime(t)).toThrow('Finalized/offline target schema cannot be opened')
  const fact={enterpriseId:1,factId:1,revision:1,status:'confirmed' as const,fact:{kind:'moved_in',source:{reference:'synthetic official',statement:'explicit'}},action:'create',actor:{type:'user' as const,id:'750'},basis:'explicit existing assertion',createdAt:'2026-11-13'}
  db.insert(schema.enterpriseFactRevision).values(fact).run()
  const input=command('fact-ref',{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'manual_review',verificationStatus:'confirmed',factReferences:[{enterpriseId:1,factId:1,revision:1,kind:'moved_in'}]})
  const saved=saveDecision102(db,input)
  expect(readDecision102(db,saved.versionId).factReferences).toEqual([{enterpriseId:1,factId:1,revision:1,kind:'moved_in'}])
  db.insert(schema.enterpriseFactRevision).values({...fact,revision:2,action:'correct'}).run()
  expect(()=>saveDecision102(db,{...input,idempotencyKey:'stale-fact',expectedCurrentId:saved.versionId})).toThrow('Fact reference must pin a current confirmed fact')
  expect(currentDecision102(db,scope).versionId).toBe(saved.versionId)
})
