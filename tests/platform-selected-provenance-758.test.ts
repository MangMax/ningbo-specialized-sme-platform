import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { targetSchema as s } from '../lib/platform/target-schema'
import { readEnterpriseSnapshot } from '../lib/roster/enterprise-read-snapshot'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { readQueryCoverage } from '../lib/roster/query-assessment'
import { sourceReader } from '../server/utils/record-correspondence-read'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { readPlatformQueryEvidence } from '../lib/platform/evidence-read'
import { listPlatformQueries } from '../lib/platform/read'
import { resolveSelectedLegacyProvenance } from '../lib/platform/target-legacy-provenance'
import { insertArchiveValue } from '../lib/platform/target-archive'
import { readComparisonTargetIdentities, readComparisonTargetQueryFacts } from '../server/utils/record-comparison-target-sources'
import { selectCandidateTargetPage } from '../server/utils/candidate-target-sources'
import { createPlatformSummaryCache, platformSummaryCache } from '../server/utils/platform-summary-cache'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import { importExecutor } from '../server/utils/import-execution'
import { createRosterImportHandler } from '../server/utils/roster-import-route'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import type { LegacyPlatformCollection, LegacyPlatformProvenanceInput } from '../lib/platform/legacy-provenance'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { assertExpandRuntime } from '../db/schema-phase'
import { correspondenceTable } from '../server/utils/record-correspondence-store'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { enterpriseReads } from '../server/utils/enterprise-read'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { createServer } from 'node:http'
import * as h3 from 'h3'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import { getTargetDeclaration, listTargetDeclarations, readTargetDeclarationFacts, readTargetDeclarationOptions } from '../server/utils/platform-declarations-target'
import { getTargetBusinessProcess } from '../server/utils/platform-business-processes-target'
import { getTargetRecognizedRecord } from '../server/utils/platform-recognized-target'

vi.mock('@db', () => ({ useDb: () => db }))
const root = mkdtempSync(join(process.env.CANDIDATE_SCOPE_EVIDENCE_DIR ?? tmpdir(), 'selected758-'))
const shared = process.env.PLATFORM_757_FIXTURES!
const oracles = process.env.PLATFORM_758_ORACLES!
let t: Database.Database, old: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>, oracle: typeof db
let serial = 0, ownerSerial = 0
const trace: string[] = []
const literal = ' { "source":"businessList", "status":"partial", "pages":[{"status":"success","rdjb":"2","page":1,"fetchedCount":1},{"status":"success","rdjb":"3","page":2,"fetchedCount":2}], "rows":[{"raw":"尾😀\\u0000"}], "unfinished":[{"page":3}], "completeness":"partial", "fullRange":false } \n'
const metadata = { sourceIdentity: ' original source ', sourceSha256: 'd'.repeat(64), segmentIndex: 3, inputFingerprint: 'e'.repeat(64), importBatchId: 1, createdAt: ' original time ' }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function open(kind = 'absent') {
  const path = join(root, `target-${++serial}.sqlite`), source = join(root, `schema0-${serial}.sqlite`)
  copyFileSync(join(shared, `${kind}-71613.sqlite`), path); chmodSync(path, 0o600)
  copyFileSync(join(oracles, `${kind}-schema0.sqlite`), source); chmodSync(source, 0o600)
  t = new Database(path, { verbose: sql => trace.push(String(sql)) }); t.pragma('foreign_keys=ON')
  old = new Database(source); old.pragma('foreign_keys=ON')
  db = drizzle(t, { schema }); oracle = drizzle(old, { schema }); trace.length = 0
}
beforeEach(() => { ownerSerial = 0; open() })
afterEach(() => { old.close(); t.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); platformSummaryCache.close() })
function normal() { old.close(); t.close(); open('normal') }
function supplement(connection = t, collectionId = 11, text = literal, segmentIndex = 3) {
  connection.exec("INSERT OR IGNORE INTO import_batch(id,idempotency_key,source_kind,source_identity,status,created_at) VALUES(1,'758','platform_archive','source','committed','c')")
  const target = drizzle(connection, { schema: s })
  return target.transaction(tx => {
    const archiveId = insertArchiveValue(tx, { storageClass: 'text', bytes: Buffer.from(text), createdAt: 'c' })
    tx.insert(s.platformCollectionLegacyProvenance).values({ ...metadata, collectionId, archiveId, origin: 'supplement', segmentIndex }).run()
    return archiveId
  })
}
function oldSupplement(queryId = 11, text = literal) {
  old.exec("INSERT OR IGNORE INTO import_batch(id,idempotency_key,source_kind,source_identity,status,created_at) VALUES(1,'758','platform_archive','source','committed','c')")
  old.prepare('INSERT INTO platform_query_legacy_provenance VALUES(?,?,?,?,?,?,?,?)').run(queryId, metadata.sourceIdentity, metadata.sourceSha256, metadata.segmentIndex, text, metadata.inputFingerprint, 1, metadata.createdAt)
}
function noLegacy() {
  expect(trace.filter(sql => /\b(?:from|join|insert into|update|delete from)\s+["`]?platform_(?:query|relation|query_legacy_provenance)["`]?(?=\s|$|\()/i.test(sql))).toEqual([])
}
function platform(id = 1) {
  const oldDetail = getRosterEnterpriseDetail(oracle, id, Date.UTC(2026, 10, 13))!
  return { old: oldDetail, target: getRosterEnterpriseDetail(db, id, Date.UTC(2026, 10, 13))! }
}
function frozen() {
  const tables = ['platform_collection', 'platform_collection_page', 'platform_collection_condition', 'platform_query_title_scope',
    'platform_business_observation', 'platform_observation_assignment', 'platform_business_record_version',
    'record_correspondence', 'difference_reason', 'evidence_revision_113', 'evidence_impact_progress_113', 'explanation_impact_113', 'evidence_review_receipt_114']
  return tables.map(table => [table, t.prepare(`SELECT * FROM ${table} ORDER BY rowid`).raw().all()])
}
function populatedHistory() {
  const official = "INSERT INTO record(id,enterprise_id,title_code,source) VALUES(101,1,'little_giant','jxj'); INSERT INTO record_event(id,record_id,event_type,year,batch_seq,sort_key) VALUES(101,101,'award',2024,1,1); INSERT INTO record_evidence(id,record_event_id,source_file,page) VALUES(101,101,'official.pdf',1)"
  for (const connection of [old, t]) connection.exec(official)
  db.insert(schema.differenceReason).values({ id: 101, enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit',
    status: 'needs_review', evidenceQueryId: 11, evidenceRelationId: 1, requestHash: ' original hash ', basis: ' { "queryId":11 } ', recordedAt: 't' }).run()
  t.exec(`INSERT INTO evidence_revision_113(id,source_kind,source_key,source_version,coverage_digest,fact_digest,coverage_changed,fact_changed,metadata,max_decision_id,created_at) VALUES(11,'platform','old','v','coverage','facts',1,1,' { "queryId":11 } ',101,' old time ');
    INSERT INTO evidence_impact_progress_113 VALUES(11,101,1);
    INSERT INTO explanation_impact_113(id,enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification) VALUES(12,1,'specialized_sme','missing_in_miit',101,11,11,'review');
    INSERT INTO evidence_review_receipt_114(id,idempotency_key,request_hash,kind,enterprise_id,title_code,direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,response,recorded_at)
    VALUES(13,'old758',' original hash ','review',1,'specialized_sme','missing_in_miit',101,101,11,' { "type":"agent" } ',' 原始 ',' { "queryId":11 } ',' time ');`)
  for (const table of ['difference_reason', 'evidence_revision_113', 'explanation_impact_113', 'evidence_review_receipt_114']) expect(t.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 1 })
}
function invariants() {
  return {
    identities: readComparisonTargetIdentities(db, [11, 12, 13]),
    facts: readComparisonTargetQueryFacts(db, [11, 12, 13]),
    candidate: selectCandidateTargetPage(db, { queryIds: [11, 12, 13], enterpriseId: 2, identity: 'U1', titleCode: 'little_giant', event: false, page: 1, pageSize: 20 }),
    coverage: ['little_giant', 'specialized_sme', 'innovative_sme'].map(titleCode => readQueryCoverage(db, { enterpriseId: 1, titleCode, direction: 'missing_in_miit' })),
  }
}
function newOwner(queryKey = 'U1', status = 'success', rows: { id: string; rdjb: string; cszt: string }[] = [{ id: 'new758', rdjb: '2', cszt: 'pending' }]) {
  const queryHigh = t.prepare('SELECT max(old_id) n FROM platform_legacy_query_alias').get() as { n: number }
  const relationHigh = t.prepare('SELECT max(old_id) n FROM platform_legacy_relation_alias').get() as { n: number }
  reserveLegacyIds(db, { query: Math.max(8000, queryHigh.n), relation: Math.max(9000, relationHigh.n) })
  const queriedAt = `2026-11-13T01:${String(serial).padStart(2, '0')}:${String(++ownerSerial).padStart(2, '0')}Z`
  writeNewCollectionTarget(db, { queryText: JSON.stringify({ interface: 'business_list', queryKey, rdjb: '2', queriedAt, status, rawResponse: ' original response \n😀 ',
    relations: rows.map((rawFields, i) => ({ sequenceNo: i + 1, relationKey: rawFields.id, nameRaw: 'Original Alpha', usccRaw: 'U1', rawFields })) }),
  evidenceText: null, createdAt: 'c', assignments: rows.map(() => ({ enterpriseId: 1, nameRaw: 'Original Alpha', usccRaw: 'U1',
    matchBasis: 'uscc', verificationStatus: 'confirmed', origin: 'command', actor: { type: 'agent', id: '758' }, basis: 'original' })) })
  const query = db.select().from(s.platformLegacyQueryAlias).orderBy(s.platformLegacyQueryAlias.oldId).all().at(-1)!
  return { queryId: query.oldId, collectionId: query.collectionId, queriedAt, rows }
}

it('selects enterprise history from structured owners before archives with unchanged schema0 membership and order', () => {
  const original = readEnterpriseSnapshot(oracle, 1), actual = readEnterpriseSnapshot(db, 1)
  expect(original.ownQueryIds.sort()).toEqual([11, 13])
  expect(actual.ownQueryIds.sort()).toEqual([11, 13])
  expect(actual.queries).toEqual(original.queries)
  expect(actual.relations.map(({ sourceText, aliasNameRaw, createdAt, ...row }) => row))
    .toEqual(original.relations.map(({ sourceText, aliasNameRaw, createdAt, ...row }) => row))
  expect(actual.relations.map(row => row.id)).toEqual([1, 3])
  noLegacy()
})
it('returns public application reads and three-source details with observation correspondence refs on complete71613', () => {
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  const rawFields = { id: 'detail-apply-758', rdjb: '2', qymc: 'Original Apply Alpha', tyshxydm: 'U1',
    sblx: '申请', year: '2025', sqsj: '2025-03-01', cszt: 'pending' }
  writeNewCollectionTarget(db, { queryText: JSON.stringify({ interface: 'apply_list', queryKey: 'U1', rdjb: '2',
    queriedAt: '2026-11-13T08:00:00Z', status: 'success', rawResponse: 'original application response',
    relations: [{ sequenceNo: 1, relationKey: rawFields.id, nameRaw: rawFields.qymc, usccRaw: 'U1', rawFields }] }),
    evidenceText: null, createdAt: 'c', assignments: [{ enterpriseId: 1, nameRaw: rawFields.qymc, usccRaw: 'U1',
      matchBasis: 'uscc', verificationStatus: 'confirmed', origin: 'command', actor: { type: 'agent', id: '758' }, basis: 'original' }] })
  expect(readEnterpriseSnapshot(db, 1).ownQueryIds.sort((a, b) => a - b)).toEqual([11, 13, 8001])
  expect(sourceReader(db, [], { kind: 'relation', id: 9001 }).read('relation', 9001)).toMatchObject({ queryId: 8001 })
  const before = t.serialize()
  const detail = getRosterEnterpriseDetail(db, 1, Date.UTC(2026, 10, 13))!
  expect(detail.platform.queries.map(row => row.id)).toEqual([13, 11, 8001])
  const observation = detail.platform.businessRecords.flatMap(row => row.observationRefs).find(row => row.relationId === 9001)
  expect(observation).toMatchObject({ queryId: 8001, enterpriseId: 1, typedFields: { interface: 'apply_list',
    projectionRuleVersion: 'platform-apply-v1', declareKind: 'apply', year: 2025, appliedAt: '2025-03-01',
    status: 'pending', nameRaw: 'Original Apply Alpha', usccRaw: 'U1',
    modeledFields: ['declareKind', 'year', 'appliedAt', 'status', 'nameRaw', 'usccRaw'] } })
  const application = listTargetDeclarations({ platformKey: rawFields.id }, db).rows[0]
  if (application?.kind !== 'record') throw new Error('Expected application record')
  expect(application).toMatchObject({ record: { platformKey: rawFields.id }, observationCount: 1 })
  expect(readTargetDeclarationOptions('records', db).statuses).toContain('pending')
  expect(getTargetDeclaration(db, application.record.id).observations).toMatchObject([{ relationId: 9001, queryId: 8001 }])
  expect(readTargetDeclarationFacts(db, [9001]).get(9001)).toMatchObject({ interface: 'apply_list', status: 'pending', year: 2025 })
  expect(readTargetDeclarationFacts(db, [9001], { scope: 'selected' })).toEqual(readTargetDeclarationFacts(db, [9001]))
  expect(() => assertExpandRuntime(t)).toThrow()
  expect(t.serialize()).toEqual(before)
  noLegacy()
  const detailUscc = '91330200712345678C'
  db.update(schema.enterprise).set({ usccNorm: detailUscc }).where(eq(schema.enterprise.id, 1)).run()
  for (const [index, source] of ['business_list', 'recognized_list'].entries()) {
    const rawFields = { id: `detail-${source}-758`, rdjb: '2', qymc: 'Original Alpha', tyshxydm: detailUscc,
      sblx: '申请', year: '2025', sqsj: '2025-03-01', cszt: 'pending', rddqrq: '2028-12-31', whpcyear: '2025', whpc: '2025-1' }
    const evidence: PlatformLiveQueryResult = { source: source === 'business_list' ? 'businessList' : 'queryBusList',
      status: 'success', effectiveConditions: { uscc: detailUscc, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] },
      queriedAt: '2026-11-13T09:00:00Z', completedAt: '2026-11-13T09:01:00Z', rows: [rawFields],
      ...(source === 'business_list' ? { dataRows: [rawFields] } : {}),
      pages: [{ source: source === 'business_list' ? 'businessList' : 'queryBusList', rdjb: '2', page: 1,
        maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
    const written = writeNewCollectionTarget(db, { queryText: JSON.stringify(platformResultToImport(evidence)),
      evidenceText: JSON.stringify(evidence), createdAt: 'c', assignments: [{ enterpriseId: 1, nameRaw: rawFields.qymc, usccRaw: detailUscc,
        matchBasis: 'uscc', verificationStatus: 'confirmed', origin: 'command', actor: { type: 'agent', id: '758' }, basis: 'original' }] })
    const observation = written.observations[0]!
    if (observation.recordId === null) throw new Error('Expected source record')
    expect(observation.observationId).not.toBe(observation.relationAlias)
    db.insert(correspondenceTable(db)).values({ id: 75800 + index, enterpriseId: 1, titleCode: 'specialized_sme',
      relationId: observation.observationId, edgeKey: `detail-${source}-758`, type: source === 'business_list' ? 'event_process' : 'event_recognized',
      role: 'candidate', status: 'rejected', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'original',
      ruleId: 'r', ruleVersion: 'v', createdAt: 'c' }).run()
    const beforeDetail = t.serialize()
    const detail = source === 'business_list' ? getTargetBusinessProcess(db, observation.recordId) : getTargetRecognizedRecord(db, observation.recordId)
    expect(detail.observations).toMatchObject([{ relationId: observation.relationAlias, queryId: written.queryAlias,
      correspondenceRefs: [{ id: 75800 + index, status: 'rejected', revision: 1 }] }])
    expect(t.serialize()).toEqual(beforeDetail)
    noLegacy()
  }
  t.exec("UPDATE platform_migration_run SET state='running' WHERE transform_version='collection-legacy-provenance-v1'")
  expect(() => listTargetDeclarations({}, db)).toThrow(/migration incomplete/)
  expect(() => readTargetDeclarationOptions('records', db)).toThrow(/migration incomplete/)
  expect(() => getTargetDeclaration(db, application.record.id)).toThrow(/migration incomplete/)
  expect(() => readTargetDeclarationFacts(db, [9001])).toThrow(/migration incomplete/)
  expect(() => readTargetDeclarationFacts(db, [9001], { scope: 'selected' })).toThrow(/migration incomplete/)
  expect(() => getRosterEnterpriseDetail(db, 1, Date.UTC(2026, 10, 13))).toThrow(/migration incomplete/)
})
it('attaches lawful supplements after enterprise selection and preserves nonempty business and coverage invariants', () => {
  populatedHistory()
  const before = frozen(), selection = invariants(), initial = platform()
  expect(initial.target.platform.queries.map(row => row.id)).toEqual([13, 11])
  expect(initial.target.platform.relations.map(row => row.id)).toEqual([1, 3])
  expect(initial.target.platform.businessRecords.length).toBeGreaterThan(0)
  expect(selection.candidate).toEqual({ total: 1, ids: [2] })
  supplement(); oldSupplement()
  const result = platform()
  expect(result.target.platform).toEqual(result.old.platform)
  expect(result.target.platform.relations.map(row => [row.id, row.sourceRdjb, row.sourcePage])).toEqual([[1, '2', 1], [3, '3', 1]])
  expect(result.target.platform.queries.find(q => q.id === 11)?.legacyProvenance?.collection).not.toHaveProperty('rows')
  expect(result.target.platform.businessRecords).toEqual(initial.target.platform.businessRecords)
  expect(result.target.qualificationAssessment).toEqual(initial.target.qualificationAssessment)
  expect(result.old.qualificationAssessment).toEqual(initial.old.qualificationAssessment)
  expect(result.old.qualificationAssessment.titles.find(title => title.titleCode === 'little_giant')?.evidence.map(row => row.eventId)).toEqual([101])
  expect(invariants()).toEqual(selection); expect(frozen()).toEqual(before); noLegacy()
})
it('shares one selected provenance decode across enterprise query and relation attachments within each request', () => {
  supplement()
  const projected = t.prepare("SELECT json_remove(?, '$.rows')").pluck().get(literal)
  const parse = vi.spyOn(JSON, 'parse')
  for (const expected of [1, 2]) {
    const snapshot = readEnterpriseSnapshot(db, 1)
    expect(snapshot.platformLegacyById?.has(11)).toBe(true)
    expect(snapshot.platformPositionsById?.get(1)).toEqual({ sourceRdjb: '2', sourcePage: 1 })
    expect(parse.mock.calls.filter(([text]) => text === projected)).toHaveLength(expected)
  }
  noLegacy()
})
it('composes public HTTP preflight commit receipt exact evidence source and injected enterprise attachments on one SQLite', async () => {
  const owner = newOwner('9133020078041158X6', 'partial')
  old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES(?,'business_list','9133020078041158X6','2',?,'partial',?,'c')").run(owner.queryId, owner.queriedAt, ' original response \n😀 ')
  old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,enterprise_id,name_raw,uscc_raw,match_basis,verification_status,status,raw_fields,created_at) VALUES(9001,?,1,'new758',1,'Original Alpha','U1','uscc','confirmed','pending',?,'c')").run(owner.queryId, JSON.stringify(owner.rows[0]))
  ensurePlatformObservation(oracle, 9001)
  populatedHistory()
  const c: LegacyPlatformCollection = { source: 'businessList', status: 'partial', effectiveConditions: { uscc: '9133020078041158X6', combination: 'and' },
    titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: owner.queriedAt, completedAt: '2026-11-13T03:00:00Z',
    rows: owner.rows, pages: [{ source: 'businessList', status: 'success', rdjb: '2', page: 2, fetchedCount: 1, declaredTotal: null, error: null }],
    fetchedCount: 1, declaredTotal: null, completeness: 'partial', fullRange: false, unfinished: [{ source: 'businessList', rdjb: '2', page: 3 }],
    error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
  const command: LegacyPlatformProvenanceInput = { queryId: owner.queryId, interface: 'business_list', queryKey: '9133020078041158X6', rdjb: '2', queriedAt: owner.queriedAt,
    sourceIdentity: 'HTTP source758', sourceSha256: 'a'.repeat(64), segmentIndex: 0, collection: c,
    relations: [{ sequenceNo: 1, relationKey: 'new758', rawFields: owner.rows[0]! }] }
  const request: RosterImportRequest = { sourceKind: 'platform_archive', sourceIdentity: 'HTTP758', idempotencyKey: 'HTTP758', payload: { platformLegacyProvenance: [command] } }
  const expectedInput = `{"query":{"id":8001,"interface":"business_list","queryKey":"9133020078041158X6","rdjb":"2","titleCode":null,"queriedAt":"${owner.queriedAt}","lastCollectedAt":null,"status":"partial","failureReason":null,"rawResponse":" original response \\n😀 ","collectionEvidence":null,"createdAt":"c"},"rows":[{"id":9001,"sequenceNo":1,"relationKey":"new758","rawFields":{"id":"new758","rdjb":"2","cszt":"pending"},"rawBytes":"{\\"id\\":\\"new758\\",\\"rdjb\\":\\"2\\",\\"cszt\\":\\"pending\\"}"}]}`
  const before = frozen(), oldResult = platform(), selection = invariants()
  vi.spyOn(enterpriseReads, 'json').mockImplementation(async (_path, input) => {
    if (input.operation !== 'detail') throw new Error('Only explicit detail injection is authorized')
    return { found: true, body: Buffer.from(JSON.stringify(getRosterEnterpriseDetail(db, input.enterpriseId, Date.UTC(2026, 10, 13)))) }
  })
  for (const key of ['defineEventHandler', 'getMethod', 'readBody', 'getHeader', 'setResponseStatus', 'setHeader', 'getQuery', 'getRouterParam', 'createError'] as const) vi.stubGlobal(key, h3[key])
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'private758', filesDir: undefined }))
  vi.spyOn(importExecutor, 'execute').mockImplementation(async (database, action, input, errors, context) => action === 'preflight'
    ? preflightRosterImport(database, input, errors, context) : commitRosterImport(database, input, errors, { ...context, deferCandidateTasks: true }))
  const router = h3.createRouter()
  for (const action of ['preflight', 'commit'] as const) router.post(`/api/roster/import/${action}`, createRosterImportHandler(action))
  router.get('/api/roster/import/receipts', (await import('../server/api/roster/import/receipts/index.get')).default)
  router.get('/api/platform/queries/:queryId/evidence', (await import('../server/api/platform/queries/[queryId]/evidence.get')).default)
  router.get('/api/roster/correspondences/relations/:id', (await import('../server/api/roster/correspondences/relations/[id].get')).default)
  router.get('/api/roster/enterprises/:id', (await import('../server/api/roster/enterprises/[id].get')).default)
  const server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected private HTTP listener')
  const base = `http://127.0.0.1:${address.port}`, headers = { authorization: 'Bearer private758', 'content-type': 'application/json' }
  async function post(action: string) {
    const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers, body: JSON.stringify(request) })
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200); return body
  }
  try {
    const unauthorized = await fetch(`${base}/api/roster/import/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    expect(unauthorized.status).toBe(401)
    expect(await post('preflight')).toMatchObject({ preflight: { add: 1, conflicts: [] } })
    const committed = await post('commit')
    expect(committed).toMatchObject({ status: 'committed', summary: { written: 1 }, items: [{ ok: true, kind: 'platform_legacy_provenance', ref: 'query:8001', detail: { provenanceKind: 'legacy_pagination', typedState: 'unknown', relationCount: 1 } }] })
    expect(await post('commit')).toEqual(committed)
    const index = db.select().from(s.platformCollectionLegacyProvenance).where(eq(s.platformCollectionLegacyProvenance.collectionId, owner.collectionId)).get()!
    expect(index.inputFingerprint).toBe(hash(expectedInput))
    const receipt = await fetch(`${base}/api/roster/import/receipts?idempotencyKey=HTTP758`, { headers })
    expect(receipt.status).toBe(200); expect(receipt.headers.get('cache-control')).toBe('no-store')
    expect(await receipt.json()).toMatchObject({ status: 'committed', itemCount: 1, summary: { written: 1 } })
    const chunks: Buffer[] = []
    for (let offset = 0;;) {
      const evidence = await fetch(`${base}/api/platform/queries/8001/evidence?field=legacyProvenance&offset=${offset}&length=11`)
      expect(evidence.status).toBe(200); expect(evidence.headers.get('cache-control')).toBe('no-store')
      const body = await evidence.json(); chunks.push(Buffer.from(body.data, 'base64')); offset += body.byteLength
      if (!body.hasMore) break
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(JSON.stringify(c)))
    const source = await fetch(`${base}/api/roster/correspondences/relations/9001`)
    expect(source.status).toBe(200); expect(source.headers.get('cache-control')).toBe('no-store')
    const sourceBody = await source.json()
    expect(sourceBody).toMatchObject({ source: { id: 9001, queryId: 8001, sourceRdjb: '2', sourcePage: 2, nameRaw: 'Original Alpha', query: { collectionEvidence: null, legacyProvenance: { kind: 'legacy_pagination' } }, correspondences: [] }, correspondences: [] })
    const enterprise = await fetch(`${base}/api/roster/enterprises/1`)
    expect(enterprise.status).toBe(200); expect(enterprise.headers.get('cache-control')).toBe('no-store')
    const enterpriseBody = await enterprise.json()
    expect(enterpriseBody.platform.relations.find((row: { id: number }) => row.id === 9001)).toMatchObject({ queryId: 8001, sourcePage: 2 })
    expect(enterpriseBody.platform.businessRecords).toEqual(oldResult.target.platform.businessRecords)
    expect((await fetch(`${base}/api/platform/queries/11/evidence?field=relation&relationId=9001`)).status).toBe(404)
    expect((await fetch(`${base}/api/roster/correspondences/relations/${owner.collectionId}`)).status).toBe(404)
    expect(frozen()).toEqual(before); expect(invariants()).toEqual(selection); noLegacy()
    writeFileSync(join(root, 'http-composition.json'), JSON.stringify({ request, receipt: committed, source: sourceBody, enterprisePlatform: enterpriseBody.platform,
      expectedInput, expectedFingerprint: hash(expectedInput), exactBytesSha256: hash(Buffer.concat(chunks)),
      injection: ['import executor invokes actual coordinator on same DB; defer unrelated tasks', 'enterprise executor invokes actual detail service including real qualification snapshot on same DB'],
      compiledNuxt: 'UNRUN', servedOpenAPI: 'UNRUN', mcpDispatcherAuth: 'UNRUN' }, null, 2))
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
it('reads valid T04 enterprise and source attachments through the same original schema0 services', () => {
  normal()
  const result = platform()
  // The shared normal successor also contains a lawful post-migration W4a owner15,
  // absent from its frozen schema0 predecessor. Compare the common source explicitly.
  expect(result.target.platform.queries.filter(row => row.id <= 13)).toEqual(result.old.platform.queries)
  expect(result.target.platform.relations.filter(row => row.id <= 8)).toEqual(result.old.platform.relations)
  expect(result.target.platform.businessRecords.filter(row => row.representativeRelationId <= 8)).toEqual(result.old.platform.businessRecords)
  expect(result.target.platform.queries.map(row => row.id)).toEqual([13, 11, 12001])
  expect(result.target.platform.relations.find(row => row.id === 16001)).toMatchObject({ queryId: 12001, nameRaw: 'Alpha', sourcePage: null })
  expect(sourceReader(db, [], { kind: 'relation', id: 5 }).read('relation', 5))
    .toEqual(sourceReader(oracle, [], { kind: 'relation', id: 5 }).read('relation', 5))
  noLegacy()
})
it('keeps same-version observations distinct and uses revision2 assignment without rewriting original identity', () => {
  const version = t.prepare('SELECT version_id FROM platform_business_observation WHERE id IN (1,2) ORDER BY id').all()
  expect(version).toHaveLength(2); expect(version[0]).toEqual(version[1])
  const assignment = db.select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId, 1)).get()!
  db.insert(s.platformObservationAssignment).values({ ...assignment, revision: 2, enterpriseId: 2, nameRaw: 'Current assertion', usccRaw: 'U2', aliasNameRaw: 'not original', origin: 'command', actor: { type: 'agent', id: '758' }, basis: 'revision2' }).run()
  old.prepare('UPDATE platform_relation SET enterprise_id=2 WHERE id=1').run()
  const snapshot = readEnterpriseSnapshot(db, 2)
  expect(snapshot.ownQueryIds.sort()).toEqual([11, 12])
  expect(snapshot.relations.map(row => row.id).sort()).toEqual([1, 2, 4])
  const result = platform(2)
  expect(result.target.platform).toEqual(result.old.platform)
  expect(result.target.platform.relations.find(row => row.id === 1)).toMatchObject({ nameRaw: 'Source', usccRaw: 'U1' })
  expect(sourceReader(db, [], { kind: 'relation', id: 1 }).read('relation', 1)).toMatchObject({ enterpriseId: 2, nameRaw: 'Source', usccRaw: 'U1', aliasNameRaw: null })
  noLegacy()
})
it('retains the exact source link closure and refuses cross-collection alias pairing without widening write authorization', () => {
  supplement()
  db.insert(correspondenceTable(db)).values({ id: 2, enterpriseId: 2, titleCode: 'little_giant', relationId: 2, edgeKey: 'unrelated',
    type: 'event_process', role: 'candidate', status: 'rejected', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'other', ruleId: 'r', ruleVersion: 'v', createdAt: 'c' }).run()
  const response = handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'relation', id: 1 }, { db })
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({ source: { id: 1, queryId: 11, sourcePage: 1, correspondences: [{ id: 1, relationId: 1 }] }, correspondences: [{ id: 1, relationId: 1 }] })
  const reader = sourceReader(db, [], { kind: 'relation', id: 5 })
  expect(reader.read('relation', 5)).toMatchObject({ id: 5, queryId: 11, sourcePage: 2, correspondences: [] })
  expect(reader.read('relation', 2)).toBeNull()
  expect(() => readPlatformQueryEvidence(db, { queryId: 12, field: 'relation', relationId: 1 })).toThrowError(expect.objectContaining({ statusCode: 404 }))
  expect(handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'relation', id: 999999 }, { db })).toMatchObject({ status: 404 })
  expect(handleRecordCorrespondenceRequest({ action: 'preflight', method: 'POST', body: {} }, { db, apiToken: 'private758' })).toMatchObject({ status: 401 })
  noLegacy()
})
it('retains normalized key failed and name-only empty histories with nonidentity public aliases', () => {
  const failed = newOwner(' u1 ', 'failed', []), named = newOwner('name:Alpha', 'no_record', []), unrelated = newOwner('unrelated', 'failed', [])
  const snapshot = readEnterpriseSnapshot(db, 1)
  expect(snapshot.ownQueryIds.sort((a, b) => a - b)).toEqual([11, 13, failed.queryId, named.queryId])
  expect(snapshot.ownQueryIds).not.toContain(unrelated.queryId)
  expect(failed.queryId).toBe(8001); expect(failed.collectionId).not.toBe(failed.queryId)
  const result = platform()
  expect(result.target.platform.queries.filter(row => row.id >= 8001)).toMatchObject([
    { id: failed.queryId, status: 'failed', relationCount: 0 }, { id: named.queryId, status: 'no_record', relationCount: 0 },
  ])
  expect(sourceReader(db, [], { kind: 'relation', id: 9001 }).read('relation', 9001)).toBeNull()
  noLegacy()
})
it('retains every selected recognized row including another assignment and an unmatched identity', () => {
  const evidence: PlatformLiveQueryResult = {
    source: 'queryBusList', status: 'success', effectiveConditions: { name: 'Alpha', combination: 'and' },
    titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-11-13T04:00:00Z', completedAt: '2026-11-13T04:01:00Z',
    rows: [{ id: 'other', qymc: 'Beta', tyshxydm: 'U2', rdjb: '2' }, { id: 'unmatched', qymc: 'Unknown', rdjb: '2' }],
    pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 2, declaredTotal: 2, error: null }],
    fetchedCount: 2, declaredTotal: 2, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const { relations, ...query } = platformResultToImport(evidence)
  const assignments = [
    { enterpriseId: 2, matchBasis: 'uscc', verificationStatus: 'confirmed' },
    { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending' },
  ] as const
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-11-13T04:02:00Z')
  try {
    writeNewCollectionTarget(db, { queryText: JSON.stringify({ ...query, relations }), evidenceText: JSON.stringify(evidence), createdAt: 'c',
      assignments: assignments.map((assignment, i) => ({ ...assignment, nameRaw: evidence.rows[i]!.qymc, usccRaw: evidence.rows[i]!.tyshxydm ?? null,
        origin: 'command', actor: { type: 'agent', id: '758' }, basis: 'original identity' })) })
  } finally { vi.useRealTimers() }
  oracle.insert(schema.platformQuery).values({ ...query, id: 8001, createdAt: 'c' }).run()
  for (const [i, relation] of relations!.entries()) {
    oracle.insert(schema.platformRelation).values({ sequenceNo: relation.sequenceNo, relationKey: relation.relationKey,
      nameRaw: relation.nameRaw, usccRaw: relation.usccRaw, rawFields: relation.rawFields,
      ...assignments[i], id: 9001 + i, queryId: 8001, createdAt: '2026-11-13T04:02:00.000Z' }).run()
    ensurePlatformObservation(oracle, 9001 + i)
  }
  const result = platform()
  expect(result.target.platform).toEqual(result.old.platform)
  expect(result.target.platform.queries.find(query => query.id === 8001)).toMatchObject({ interface: 'recognized_list', relationCount: 2 })
  expect(result.target.platform.relations.filter(row => row.queryId === 8001).map(row => [row.id, row.enterpriseId, row.usccRaw, row.sourcePage]))
    .toEqual([[9001, 2, 'U2', 1], [9002, null, null, 1]])
  expect(sourceReader(db, [], { kind: 'relation', id: 9002 }).read('relation', 9002))
    .toEqual(sourceReader(oracle, [], { kind: 'relation', id: 9002 }).read('relation', 9002))
  noLegacy()
})
function corruption(mutation: string, check: () => void) {
  const rollback = Symbol('private corruption')
  t.pragma('foreign_keys=OFF')
  try { db.transaction(() => {
    for (const { name } of t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all() as { name: string }[]) t.exec(`DROP TRIGGER "${name}"`)
    t.exec(mutation); check(); throw rollback
  }) } catch (error) { if (error !== rollback) throw error } finally { t.pragma('foreign_keys=ON') }
}
it.each([
  ['missing index', 'DELETE FROM platform_collection_legacy_provenance WHERE collection_id=11'],
  ['metadata conflict', "UPDATE platform_collection_legacy_provenance SET source_identity='wrong' WHERE collection_id=11"],
  ['owner conflict', "DELETE FROM platform_collection_legacy_provenance WHERE collection_id=12; UPDATE platform_collection_legacy_provenance SET archive_id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=12 AND field='legacyProvenance') WHERE collection_id=11"],
  ['unsealed ref', "UPDATE platform_collection_archive_ref SET sealed=0 WHERE owner_id=11 AND field='legacyProvenance'"],
  ['archive hash drift', `UPDATE platform_archive_value SET sha256='${'f'.repeat(64)}' WHERE id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=11 AND field='legacyProvenance')`],
  ['extra ref', "INSERT INTO platform_archive_value(storage_class,bytes,byte_length,sha256,created_at) VALUES('null',NULL,NULL,NULL,NULL); INSERT INTO platform_collection_archive_ref VALUES(11,'request',last_insert_rowid(),1)"],
] as const)('refuses enterprise and actual source attachment lifecycle %s', (_name, mutation) => {
  normal()
  corruption(mutation, () => {
    expect(() => readEnterpriseSnapshot(db, 1)).toThrow(/lifecycle|field set|Incomplete sealed|hash/)
    expect(() => handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'relation', id: 1 }, { db })).toThrow(/lifecycle|field set|Incomplete sealed|hash/)
  })
})
it('refuses missing supplement archive unfinished completion and invalid W4a owner16 without online repair', () => {
  const archiveId = supplement(), before = t.prepare('SELECT count(*) n FROM platform_archive_value').get()
  for (const mutation of [
    `DELETE FROM platform_archive_value WHERE id=${archiveId}`,
    `UPDATE platform_archive_value SET storage_class='blob' WHERE id=${archiveId}`,
    "UPDATE platform_migration_run SET state='running' WHERE transform_version='collection-legacy-provenance-v1'",
  ]) corruption(mutation, () => {
    expect(() => readEnterpriseSnapshot(db, 1)).toThrow()
    expect(() => sourceReader(db, [], { kind: 'relation', id: 1 })).toThrow()
  })
  expect(t.prepare('SELECT count(*) n FROM platform_archive_value').get()).toEqual(before)
  expect(() => assertExpandRuntime(t)).toThrow('Finalized/offline target')
  normal()
  expect(() => listPlatformQueries(db, { queryId: 12002 })).toThrow('Contradictory original command provenance input')
  expect(sourceReader(db, [], { kind: 'relation', id: 16001 }).read('relation', 16001)).toMatchObject({ id: 16001, queryId: 12001 })
})
it('budgets selected enterprise and source metadata before hydration while ignoring unrelated giant archives', () => {
  const giant = newOwner('unrelated', 'no_record', [])
  supplement(t, giant.collectionId, JSON.stringify({ pages: [], rows: [], pad: 'x'.repeat(9 * 1024 * 1024) }), 4)
  expect(readEnterpriseSnapshot(db, 1).ownQueryIds.sort()).toEqual([11, 13])
  expect(sourceReader(db, [], { kind: 'relation', id: 1 }).read('relation', 1)).toMatchObject({ id: 1 })
  supplement(t, 11, JSON.stringify({ pages: [], rows: [], pad: 'x'.repeat(4 * 1024 * 1024) }))
  for (const read of [() => readEnterpriseSnapshot(db, 1), () => sourceReader(db, [], { kind: 'relation', id: 1 })]) {
    trace.length = 0
    expect(read).toThrowError(expect.objectContaining({ statusCode: 413 }))
    expect(trace.some(sql => /select[^;]*"platform_archive_value"\."bytes"/i.test(sql))).toBe(false)
  }
})
it('keeps historical locator value types and original normalization conflicts in enterprise and source attachments', () => {
  const assignment = db.select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId, 5)).get()!
  db.insert(s.platformObservationAssignment).values({ ...assignment, revision: 2, enterpriseId: 1, origin: 'command', actor: { type: 'agent', id: '758' }, basis: 'selected history' }).run()
  old.exec('UPDATE platform_relation SET enterprise_id=1 WHERE id=5')
  const text = '{"pages":[{"status":"success","rdjb":null,"page":null,"fetchedCount":1},{"status":"success","rdjb":false,"page":"09","fetchedCount":2}],"rows":[]}'
  supplement(t, 11, text); oldSupplement(11, text)
  const result = platform()
  expect(result.target.platform).toEqual(result.old.platform)
  expect(result.target.platform.relations.map(row => [row.id, row.sourceRdjb, row.sourcePage])).toEqual([[1, null, null], [5, false, '09'], [3, '3', 1]])
  const source = sourceReader(db, [], { kind: 'relation', id: 5 }).read('relation', 5)
  expect(source).toEqual(sourceReader(oracle, [], { kind: 'relation', id: 5 }).read('relation', 5))
  expect(source).toMatchObject({ sourceRdjb: false, sourcePage: '09' })
  noLegacy()
})
it('preserves exact 4MiB query and 8MiB enterprise page limits for selected empty histories', () => {
  db.insert(schema.enterprise).values({ id: 3, name: 'Gamma', nameNorm: 'Gamma' }).run()
  const cap = 4 * 1024 * 1024
  function padded(size: number) {
    return JSON.stringify({ pages: [], rows: ['excluded'], pad: 'x'.repeat(size - Buffer.byteLength('{"pages":[],"pad":""}')) })
  }
  const first = newOwner('name:Gamma', 'no_record', [])
  supplement(t, first.collectionId, padded(cap), 10)
  expect(readEnterpriseSnapshot(db, 3).ownQueryIds).toEqual([first.queryId])
  const second = newOwner('name:Gamma', 'no_record', [])
  supplement(t, second.collectionId, padded(cap), 11)
  expect(readEnterpriseSnapshot(db, 3).ownQueryIds).toEqual([first.queryId, second.queryId])
  newOwner('name:Gamma', 'no_record', []) // zero-byte history stays at 8MiB
  expect(readEnterpriseSnapshot(db, 3).ownQueryIds).toHaveLength(3)
  const third = db.select().from(s.platformLegacyQueryAlias).orderBy(s.platformLegacyQueryAlias.oldId).all().at(-1)!
  supplement(t, third.collectionId, '{}', 12) // smallest lawful object exceeds the page budget by two bytes
  trace.length = 0
  expect(() => readEnterpriseSnapshot(db, 3)).toThrowError(expect.objectContaining({ statusCode: 413 }))
  expect(trace.some(sql => /select[^;]*"platform_archive_value"\."bytes"/i.test(sql))).toBe(false)
})
it('keeps enterprise and source reads in one snapshot and sees committed supplements on the next request', () => {
  t.pragma('journal_mode=WAL')
  const writer = new Database(t.name); writer.pragma('foreign_keys=ON')
  let changed = false
  const snapshot = drizzle(t, { schema, logger: { logQuery(sql) {
    if (!changed && sql.includes('from "platform_collection_legacy_provenance"')) { changed = true; supplement(writer) }
  } } })
  try {
    db.transaction(() => {
      const enterprise = readEnterpriseSnapshot(snapshot, 1)
      expect(enterprise.platformLegacyById?.size).toBe(0)
      expect(sourceReader(snapshot, [], { kind: 'relation', id: 1 }).read('relation', 1)).not.toHaveProperty('query.legacyProvenance')
    })
    expect(changed).toBe(true)
    expect(readEnterpriseSnapshot(db, 1).platformLegacyById?.get(11)).toHaveProperty('collection')
    expect(sourceReader(db, [], { kind: 'relation', id: 1 }).read('relation', 1)).toHaveProperty('query.legacyProvenance')
  } finally { writer.close() }
})
it('publishes commit only and preserves summary observer rollback and no-store bypass', () => {
  t.pragma('journal_mode=WAL')
  const cache = createPlatformSummaryCache()
  try {
    const before = cache.read(db, { view: 'summary' })
    t.exec('BEGIN'); supplement()
    expect(readEnterpriseSnapshot(db, 1).platformLegacyById?.size).toBe(1)
    expect(sourceReader(db, [], { kind: 'relation', id: 1 }).read('relation', 1)).toHaveProperty('query.legacyProvenance')
    expect(cache.read(db, { view: 'summary' })).toEqual(before)
    t.exec('ROLLBACK')
    expect(readEnterpriseSnapshot(db, 1).platformLegacyById?.size).toBe(0)
    expect(sourceReader(db, [], { kind: 'relation', id: 1 }).read('relation', 1)).not.toHaveProperty('query.legacyProvenance')
    expect(cache.read(db, { view: 'summary' })).toEqual(before)
    supplement(); expect(cache.read(db, { view: 'summary' })).toEqual(before)
    expect(cache.stats()).toMatchObject({ misses: 2, hits: 1, bypasses: 1 })
    cache.read(db, { view: 'summary' }, { allowStore: false }); expect(cache.stats().bypasses).toBe(2)
  } finally { cache.close() }
})
it('records the normal current qualified list gap separately from the working enterprise detail qualification snapshot', () => {
  t.exec("INSERT INTO record(id,enterprise_id,title_code,source) VALUES(101,1,'little_giant','jxj'); INSERT INTO record_event(id,record_id,event_type,year,batch_seq,sort_key) VALUES(101,101,'award',2024,1,1); INSERT INTO record_evidence(id,record_event_id,source_file,page) VALUES(101,101,'official.pdf',1)")
  expect(getRosterEnterpriseDetail(db, 1, Date.UTC(2026, 10, 13))?.qualificationAssessment.titles.find(title => title.titleCode === 'little_giant')?.evidence.map(row => row.eventId)).toEqual([101])
  noLegacy()
  let error: unknown
  try { listCurrentQualified(t, { titleCode: 'little_giant' }) } catch (value) { error = value }
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toMatch(/no such column.*relation_id/)
  writeFileSync(join(root, 'normal-qualification-gap.json'), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null,
    entry: 'listCurrentQualified -> currentCandidateReadSqlFor', qualification: 'Current-qualified list FAIL; enterprise detail default T2 runs on target owners; #738-742 unchanged', compiledWire: 'UNRUN' }, null, 2))
})
