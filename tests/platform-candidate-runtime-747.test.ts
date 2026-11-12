import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { createOfflineSnapshot } from '../upgrade/offline-snapshot'
import { transferCorrespondence } from '../upgrade/correspondence'
import { discoverEventArchives } from '../server/utils/event-archive-discovery'
import { generateCandidates } from '../server/utils/record-correspondence-candidates'
import { whenIdle, __resetJobRunner, clearJobSpecs, requestJobCancel, ensureJobRunnerReady } from '../server/utils/job-runner'
import { handleCandidateJobRequest, dispatchCandidateJobMcp } from '../server/utils/candidate-job-api'
import { listRecordCorrespondences, getRecordCorrespondenceAudit, preflightRecordCorrespondences, commitRecordCorrespondences, type CorrespondenceRequest } from '../server/utils/record-correspondence'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { enqueueArchivedCandidates, activateCandidateDiscoveryTasks, submitCandidateDiscovery, retryCandidateDiscovery, type CandidateJobResult } from '../server/utils/jobs/candidate-discovery'
import { getJob } from '../server/utils/job-store'
import { eq } from 'drizzle-orm'
import { assertExpandRuntime } from '../db/schema-phase'
import { z } from 'zod'

async function candidateRuntimeFixture(seed: (source: Database.Database) => void) {
  const f = await witnessReaderFixture(seed)
  f.close()
  const source = join(f.root, 'process-source.sqlite')
  await createOfflineSnapshot(f.target, source)
  finalizeProcessStored({ source, target: f.target, runId: 'process', predecessorRunId: 'witness', legacySource: f.legacySource })
  const old = new Database(f.legacySource, { readonly: true })
  return { ...f, old: drizzle(old, { schema }), close() { old.close() } }
}
let fixture: Awaited<ReturnType<typeof candidateRuntimeFixture>>
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
const statements: string[] = []
beforeAll(async () => {
  fixture = await candidateRuntimeFixture(source => {
    const old = drizzle(source, { schema })
    old.insert(schema.enterprise).values({ id: 10, name: 'Candidate', nameNorm: 'Candidate', usccNorm: 'U10' }).run()
    old.insert(schema.record).values({ id: 10, enterpriseId: 10, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U10' }).run()
    old.insert(schema.recordEvent).values({ id: 10, recordId: 10, eventType: 'award', year: 2024, batchSeq: 1 }).run()
    for (const [id, sourceKind] of [[401, 'business_list'], [402, 'apply_list'], [403, 'recognized_list']] as const) {
      old.insert(schema.platformQuery).values({ id, interface: sourceKind, queryKey: 'U10', rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-${String(id - 400).padStart(2, '0')}T00:00:00Z`, status: 'success' }).run()
      old.insert(schema.platformRelation).values({ id, queryId: id, sequenceNo: 1, relationKey: 'SHARED', enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Candidate', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: 'SHARED', rdjb: '2', sblx: '申请', sqsj: '2024-01-01', year: 2024, whpcyear: 2024, whpc: '2024-1', cszt: '终审通过' } }).run()
      ensurePlatformObservation(old, id)
    }
    old.insert(schema.recordEvent).values([11, 12, 13, 14].map(id => ({ id, recordId: 10, eventType: 'award' as const, year: 2024, batchSeq: 1 }))).run()
    for (const [eventId, status] of [[11, 'candidate'], [12, 'confirmed'], [13, 'rejected'], [14, 'confirmed']] as const) {
      const receipt = manual(old, 'old747-' + eventId, [{ action: 'create', status, edge: { type: 'event_process', eventId, relationId: 401, role: 'supports_award' } }])
      if (eventId === 14) manual(old, 'old747-unlink', [{ action: 'decide', correspondenceId: receipt.correspondenceIds[0]!, expectedRevision: 2, status: 'unlinked' }])
    }
    old.insert(schema.enterpriseAlias).values({ enterpriseId: 10, name: 'Former', nameNorm: 'Former', verificationStatus: 'confirmed', sourceKind: 'manual' }).run()
    for (const [id, status] of [[404, 'failed'], [405, 'partial'], [406, 'no_record'], [407, 'not_queried']] as const) {
      old.insert(schema.platformQuery).values({ id, interface: 'apply_list', queryKey: 'name:Former', rdjb: '2', queriedAt: `2026-10-${String(id - 400).padStart(2, '0')}T00:00:00Z`, status }).run()
    }
    old.insert(schema.enterprise).values({ id: 20, name: 'Mixed', nameNorm: 'Mixed', usccNorm: 'U20' }).run()
    old.insert(schema.record).values({ id: 20, enterpriseId: 20, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U20' }).run()
    old.insert(schema.recordEvent).values({ id: 20, recordId: 20, eventType: 'review', year: 2021, decidedYear: 2024, batchSeq: 1 }).run()
    old.insert(schema.platformQuery).values({ id: 501, interface: 'recognized_list', queryKey: 'U20', rdjb: '2,3', queriedAt: '2026-11-01T00:00:00Z', status: 'partial',
      collectionEvidence: { pages: [{ status: 'success', rdjb: '2', page: 1, fetchedCount: 2 }, { status: 'success', rdjb: '3', page: 1, fetchedCount: 1 }, { status: 'failed', rdjb: '3', page: 2, fetchedCount: 0 }] } as typeof schema.platformQuery.$inferInsert.collectionEvidence }).run()
    for (const [id, seq, usccRaw, rdjb] of [[501, 1, 'U20', '3'], [502, 2, null, null], [503, 3, 'U20', '2']] as const) {
      old.insert(schema.platformRelation).values({ id, queryId: 501, sequenceNo: seq, enterpriseId: 20, verificationStatus: 'confirmed', matchBasis: usccRaw ? 'uscc' : 'alias', nameRaw: 'Mixed', usccRaw, rawFields: { id: 'M' + id, ...(rdjb ? { rdjb } : {}), year: 2024 } }).run()
      ensurePlatformObservation(old, id)
    }
    for (const [id, status] of [[504, 'no_record'], [505, 'failed'], [506, 'success']] as const) {
      old.insert(schema.platformQuery).values({ id, interface: 'recognized_list', queryKey: 'U20', rdjb: '2,3', queriedAt: `2026-11-${String(id - 500).padStart(2, '0')}T00:00:00Z`, status }).run()
    }
    old.insert(schema.enterprise).values({ id: 30, name: 'Continuation', nameNorm: 'Continuation', usccNorm: 'U30' }).run()
    old.insert(schema.record).values({ id: 30, enterpriseId: 30, titleCode: 'little_giant', source: 'jxj', usccRaw: 'U30' }).run()
    old.insert(schema.recordEvent).values(Array.from({ length: 201 }, (_, i) => ({ id: 1000 + i, recordId: 30, eventType: 'award' as const, year: 2024, batchSeq: 1 }))).run()
    old.insert(schema.enterprise).values({ id: 40, name: 'Generic', nameNorm: 'Generic', usccNorm: 'U40' }).run()
    old.insert(schema.record).values({ id: 40, enterpriseId: 40, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U40' }).run()
    old.insert(schema.recordEvent).values({ id: 40, recordId: 40, eventType: 'award', year: 2024, batchSeq: 1 }).run()
    for (const id of [601, 602, 603]) {
      old.insert(schema.platformQuery).values({ id, interface: 'business_list', queryKey: 'U40', rdjb: '2,3', queriedAt: `2026-11-${String(id - 600).padStart(2, '0')}T00:00:00Z`, status: 'success' }).run()
      old.insert(schema.platformRelation).values({ id, queryId: id, sequenceNo: 1, relationKey: id === 603 ? 'OTHER' : 'SAME', enterpriseId: 40, usccRaw: 'U40', verificationStatus: 'confirmed', matchBasis: 'uscc',
        rawFields: { id: id === 603 ? 'OTHER' : 'SAME', rdjb: 2, sblx: '申请', year: 2024 } }).run()
      ensurePlatformObservation(old, id)
    }
    old.insert(schema.platformExportBatch).values({ id: 701, titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-11-01', originalFilename: 'synthetic.xlsx', sha256: 'synthetic747', importStatus: 'imported', rowCount: 2 }).run()
    old.insert(schema.platformExportRow).values([701, 702].map((id, i) => ({ id, batchId: 701, sourceRowNo: i + 1, usccRaw: 'U40', nameRaw: 'Generic' }))).run()
  })
  const source = join(fixture.root, 'candidate-71610.sqlite'), target = join(fixture.root, 'candidate-71611.sqlite')
  await createOfflineSnapshot(fixture.target, source)
  copyFileSync(source, target)
  transferCorrespondence({ source, target, runId: 'candidate747' })
  sqlite = new Database(target, { verbose: query => statements.push(String(query)) })
  sqlite.pragma('foreign_keys=ON')
  db = drizzle(sqlite, { schema })
})
beforeEach(() => sqlite.exec('SAVEPOINT candidate_case'))
afterEach(async () => { await whenIdle(); __resetJobRunner(); clearJobSpecs(); sqlite.exec('ROLLBACK TO candidate_case; RELEASE candidate_case') })
afterAll(() => { sqlite?.close(); fixture?.close() })

it('discovers migrated three-source candidates and independent coverage pages equal to old normal services', () => {
  const input = { eventId: 10, page: 1, pageSize: 1, queryPage: 2, queryPageSize: 2 }
  const old = discoverEventArchives(fixture.old, input)!
  expect(old).toMatchObject({ total: 3, rows: [{ edge: { relationId: 401 } }], coverage: { total: 7, rows: [{ id: 403 }, { id: 404 }] } })
  statements.length = 0
  expect(discoverEventArchives(db, input)).toEqual(old)
  const candidates = { eventId: 10, queryIds: [401, 402, 403], exportBatchIds: [], ruleVersion: 'oracle747', page: 1, pageSize: 25 }
  expect(generateCandidates(db, candidates)).toEqual(generateCandidates(fixture.old, candidates))
  expect(statements.some(query => /\b(?:from|join)\s+"platform_(?:query|relation)"(?:\s|$)/i.test(query))).toBe(false)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('submits executes and reads candidate tasks through public REST and MCP services', async () => {
  const context = { db, filesDir: fixture.root, browserAuthorized: true }
  const receipt = await handleCandidateJobRequest('submit', { method: 'POST', path: '', body: { clientRequestId: 'normal747', queryId: 401 } }, context)
  expect(receipt).toMatchObject({ status: 202 })
  const { jobId } = z.object({ jobId: z.string() }).parse(receipt.body)
  await whenIdle()
  expect(await dispatchCandidateJobMcp('detail', { id: jobId }, { db, filesDir: fixture.root })).toMatchObject({ state: 'done' })
  expect(checkpoint(jobId)!.items.map(item => item.eventId)).toEqual([10, 11, 12, 13, 14])
  expect(listRecordCorrespondences(db, { eventId: 10 })).toEqual(expect.arrayContaining([
    expect.objectContaining({ relationId: 401, status: 'confirmed', role: 'context_only' }),
    expect.objectContaining({ relationId: 403, status: 'candidate', role: 'recognized_corrob' }),
  ]))
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

function manual(database: typeof db, key: string, operations: CorrespondenceRequest['operations']) {
  const request: CorrespondenceRequest = { idempotencyKey: key, sourceIdentity: 'synthetic747/' + key, actor: { type: 'user', id: 'reviewer' }, basis: 'normal explicit decision', ruleId: 'manual', ruleVersion: '1', operations }
  return commitRecordCorrespondences(database, request, preflightRecordCorrespondences(database, request).planHash)
}
function addSource(key: string, options: { owner?: number; source?: 'business_list' | 'recognized_list'; queriedAt?: string; rawResponse?: string; count?: number } = {}, database = db) {
  const owner = options.owner ?? 10, source = options.source ?? 'business_list', queriedAt = options.queriedAt ?? '2026-11-10T00:00:00Z'
  const relations = Array.from({ length: options.count ?? 1 }, (_, i) => ({ sequenceNo: i + 1, relationKey: key + i, enterpriseId: owner, usccRaw: 'U' + owner, nameRaw: 'Candidate',
    verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: key + i, sblx: '申请', sqsj: '2024-09-01', year: 2024, cszt: '待审', rdjb: owner === 30 ? '3' : '2' } }))
  const receipt = writeNewCollectionTarget(database, { queryText: JSON.stringify({ interface: source, queryKey: 'U' + owner, rdjb: owner === 30 ? '3' : '2', titleCode: owner === 30 ? 'little_giant' : 'specialized_sme', queriedAt, status: 'success', rawResponse: options.rawResponse ?? 'normal evidence', relations }),
    evidenceText: null, createdAt: queriedAt, assignments: relations.map(() => ({ enterpriseId: owner, usccRaw: 'U' + owner, nameRaw: 'Candidate', verificationStatus: 'confirmed', matchBasis: 'uscc', origin: 'command' as const, actor: { type: 'user' as const, id: 'reviewer' }, basis: 'exact source identity', recordedAt: queriedAt })) })
  return { ...receipt, coordinate: { interface: source, queryKey: 'U' + owner, rdjb: owner === 30 ? '3' : '2', queriedAt } }
}
function checkpoint(id: string) { return getJob(db, id)?.result as CandidateJobResult | null }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it('preserves recognized page partitions confirmed aliases partial failed empty and unqueried coverage', () => {
  for (const input of [
    { eventId: 20, page: 1, pageSize: 1, queryPage: 1, queryPageSize: 1 },
    { eventId: 20, page: 2, pageSize: 1, queryPage: 2, queryPageSize: 1 },
    { eventId: 10, page: 4, pageSize: 1, queryPage: 2, queryPageSize: 3 },
  ]) expect(discoverEventArchives(db, input)).toEqual(discoverEventArchives(fixture.old, input))
  const mixed = discoverEventArchives(db, { eventId: 20, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25 })!
  expect(mixed).toMatchObject({ total: 2, rows: [{ edge: { relationId: 501 }, evidence: { source: { sourceRdjb: '2', sourcePage: 1 } }, conflicts: expect.arrayContaining(['title_conflict']) }, { edge: { relationId: 502 } }], coverage: { rows: [{ relationCount: 3, candidateCount: 2, outcome: 'partial' }, { outcome: 'no_record' }, { outcome: 'failed' }, { outcome: 'empty_unproven' }] } })
  const states = discoverEventArchives(db, { eventId: 10, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25 })!
  expect(states.coverage.rows.map(r => r.outcome)).toEqual(['candidates', 'candidates', 'candidates', 'failed', 'partial', 'no_record', 'not_queried'])
  expect(discoverEventArchives(db, { eventId: 1000, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25 })).toMatchObject({ total: 0, rows: [], coverage: { total: 0, rows: [] }, interfaces: [{ queried: false }, { queried: false }, { queried: false }] })
})

it('limits recognized mixed-query and title jobs to their own affected events', async () => {
  const recognized = submitCandidateDiscovery(db, { clientRequestId: 'mixed-scope747', queryId: 501 }, fixture.root)
  await whenIdle()
  expect(getJob(db, recognized.jobId)).toMatchObject({ state: 'done', result: { counts: { succeeded: 1, created: 2 }, items: [{ eventId: 20 }] } })
  const title = submitCandidateDiscovery(db, { clientRequestId: 'title-scope747', titleCode: 'specialized_sme' }, fixture.root)
  await whenIdle()
  expect(getJob(db, title.jobId)?.state).toBe('done')
  expect(checkpoint(title.jobId)!.items.map(item => item.eventId)).toEqual([10, 11, 12, 13, 14, 20, 40])
})

it('resolves nonidentity aliases and retains distinct same-version observations on subsequent requests', () => {
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  const first = addSource('SAME'), second = addSource('SAME', { queriedAt: '2026-11-11T00:00:00Z' })
  expect(first.queryAlias).not.toBe(first.collectionId)
  expect(first.observations[0]!.relationAlias).not.toBe(first.observations[0]!.observationId)
  expect(second.observations[0]!.versionId).toBe(first.observations[0]!.versionId)
  const input = { eventId: 10, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25 }
  const discovered = discoverEventArchives(db, input)!
  expect(discovered.total).toBe(5)
  expect(discovered.rows.flatMap(row => (row.observationRefs as { relationId: number }[]).map(r => r.relationId))).toEqual([401, 402, 403, first.observations[0]!.relationAlias, second.observations[0]!.relationAlias])
  expect(discoverEventArchives(db, { ...input, page: 5, pageSize: 1 })!.rows).toMatchObject([{ edge: { relationId: second.observations[0]!.relationAlias } }])
  addSource('NEXT', { queriedAt: '2026-11-12T00:00:00Z' })
  expect(discoverEventArchives(db, input)!.total).toBe(6)
})

it.each([[11, 'candidate'], [12, 'confirmed'], [13, 'rejected'], [14, 'unlinked']] as const)('protects historical %s %s decisions across all roles', async (eventId, status) => {
  const prior = listRecordCorrespondences(db, { eventId }).find(row => row.relationId === 401)!
  const audit = getRecordCorrespondenceAudit(db, prior.id)
  expect(prior).toMatchObject({ role: 'supports_award', status })
  const receipt = submitCandidateDiscovery(db, { clientRequestId: 'protect747-' + eventId, eventIds: [eventId] }, fixture.root)
  await whenIdle()
  expect(getJob(db, receipt.jobId)).toMatchObject({ state: 'done', result: { counts: { created: 2, existing: 1 } } })
  expect(listRecordCorrespondences(db, { eventId }).filter(row => row.relationId === 401)).toEqual([prior])
  expect(getRecordCorrespondenceAudit(db, prior.id)).toEqual(audit)
})

it('stages target archives atomically deduplicates activation and hands the completed slice to annual services', async () => {
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  const source = addSource('STAGED')
  let ids: string[] = []
  expect(() => db.transaction(() => { ids = enqueueArchivedCandidates(db, [source.coordinate], fixture.root, true); throw new Error('archive transaction rollback') })).toThrow('archive transaction rollback')
  expect(getJob(db, ids[0]!)).toBeNull()
  ids = db.transaction(() => enqueueArchivedCandidates(db, [source.coordinate], fixture.root, true))
  expect(getJob(db, ids[0]!)).toMatchObject({ state: 'queued', params: { queryId: source.queryAlias, clientRequestId: `archive:${source.queryAlias}:${source.observations[0]!.relationAlias}:event-archive-212-v1` } })
  expect(enqueueArchivedCandidates(db, [source.coordinate], fixture.root, true)).toEqual(ids)
  activateCandidateDiscoveryTasks(db, ids, fixture.root)
  await whenIdle()
  expect(getJob(db, ids[0]!)).toMatchObject({ state: 'done', result: { counts: { succeeded: 5, failed: 0 } } })
  const before = listRecordCorrespondences(db).map(row => [row.id, getRecordCorrespondenceAudit(db, row.id)])
  expect(enqueueArchivedCandidates(db, [source.coordinate], fixture.root, true)).toEqual(ids)
  activateCandidateDiscoveryTasks(db, ids, fixture.root)
  await whenIdle()
  expect(listRecordCorrespondences(db).map(row => [row.id, getRecordCorrespondenceAudit(db, row.id)])).toEqual(before)
  expect(listRecordCorrespondences(db, { eventId: 10 })).toContainEqual(expect.objectContaining({ relationId: source.observations[0]!.relationAlias, status: 'confirmed' }))
  expect(db.select().from(schema.job).all()).toContainEqual(expect.objectContaining({ kind: 'event-annual-correspondence', state: 'done' }))
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('cancels between rows and resumes the durable 25-row page checkpoint after runner restart', async () => {
  addSource('PAGED', { count: 28 })
  const receipt = submitCandidateDiscovery(db, { clientRequestId: 'cancel747', eventIds: [10] }, fixture.root)
  for (let i = 0; i < 1000 && (checkpoint(receipt.jobId)?.counts.created ?? 0) < 1; i++) await tick()
  expect(checkpoint(receipt.jobId)?.counts.created).toBe(1)
  requestJobCancel(db, receipt.jobId)
  await whenIdle()
  expect(getJob(db, receipt.jobId)).toMatchObject({ state: 'cancelled', result: { items: [{ rowIndex: 1, page: 1 }], counts: { created: 1 } } })
  const prior = listRecordCorrespondences(db, { eventId: 10 })[0]!
  manual(db, 'intervening747', [{ action: 'decide', correspondenceId: prior.id, expectedRevision: 1, status: 'rejected' }])
  const audit = getRecordCorrespondenceAudit(db, prior.id)
  __resetJobRunner(); ensureJobRunnerReady(db)
  retryCandidateDiscovery(db, receipt.jobId, fixture.root)
  await whenIdle()
  expect(getJob(db, receipt.jobId)).toMatchObject({ state: 'done', result: { attempt: 2, counts: { created: 31 }, items: [{ page: 2, rowIndex: 6 }] } })
  expect(getRecordCorrespondenceAudit(db, prior.id)).toEqual(audit)
  expect(listRecordCorrespondences(db, { eventId: 10 })).toHaveLength(31)
})

it('rolls back a failed row and retries only unfinished candidate writes', async () => {
  sqlite.exec("CREATE TRIGGER candidate_fail BEFORE INSERT ON record_correspondence WHEN NEW.event_id=10 AND NEW.observation_id=402 BEGIN SELECT RAISE(ABORT,'synthetic candidate failure'); END")
  const receipt = submitCandidateDiscovery(db, { clientRequestId: 'rollback747', eventIds: [10] }, fixture.root)
  await whenIdle()
  expect(getJob(db, receipt.jobId)).toMatchObject({ state: 'failed', result: { items: [{ page: 1, rowIndex: 1, errorCode: 'candidate_persistence_failed' }], counts: { created: 1 } } })
  const prior = listRecordCorrespondences(db, { eventId: 10 })[0]!, audit = getRecordCorrespondenceAudit(db, prior.id)
  sqlite.exec('DROP TRIGGER candidate_fail')
  retryCandidateDiscovery(db, receipt.jobId, fixture.root)
  await whenIdle()
  expect(getJob(db, receipt.jobId)).toMatchObject({ state: 'done', result: { attempt: 2, counts: { created: 3 } } })
  expect(getRecordCorrespondenceAudit(db, prior.id)).toEqual(audit)
})

it('keeps ordinary source and revision conflicts atomic through the reused correspondence service', () => {
  const created = manual(db, 'source747-create', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: 10, relationId: 401, role: 'context_only' } }])
  const id = created.correspondenceIds[0]!
  const request: CorrespondenceRequest = { idempotencyKey: 'source747-confirm', sourceIdentity: 'synthetic747/source', actor: { type: 'user', id: 'reviewer' }, basis: 'normal explicit decision', ruleId: 'manual', ruleVersion: '1',
    operations: [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }] }
  const plan = preflightRecordCorrespondences(db, request), audit = getRecordCorrespondenceAudit(db, id)
  db.update(schema.recordEvent).set({ year: 2025, revision: 2 }).where(eq(schema.recordEvent.id, 10)).run()
  expect(() => commitRecordCorrespondences(db, request, plan.planHash)).toThrowError(expect.objectContaining({ code: 'plan_mismatch' }))
  expect(getRecordCorrespondenceAudit(db, id)).toEqual(audit)
  const confirmed = listRecordCorrespondences(db, { eventId: 12 })[0]!
  const stale: CorrespondenceRequest = { ...request, idempotencyKey: 'revision747', operations: [{ action: 'decide', correspondenceId: confirmed.id, expectedRevision: confirmed.revision, status: 'unlinked' }] }
  const stalePlan = preflightRecordCorrespondences(db, stale)
  manual(db, 'revision747-competing', [{ action: 'decide', correspondenceId: confirmed.id, expectedRevision: confirmed.revision, status: 'unlinked' }])
  expect(() => commitRecordCorrespondences(db, stale, stalePlan.planHash)).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
  expect(listRecordCorrespondences(db, { id: confirmed.id })).toMatchObject([{ status: 'unlinked', revision: confirmed.revision + 1 }])
})

it('charges the original target owned bytes at four MiB and preserves completed rows above the envelope', async () => {
  const raw = { id: 'LIMIT0', sblx: '申请', sqsj: '2024-09-01', year: 2024, cszt: '待审', rdjb: '2' }
  const bytes = Buffer.byteLength(JSON.stringify(raw))
  const exact = addSource('LIMIT', { rawResponse: 'x'.repeat(4 * 1024 * 1024 - bytes) })
  const receipt = submitCandidateDiscovery(db, { clientRequestId: 'limit747', eventIds: [10] }, fixture.root)
  await whenIdle()
  expect(getJob(db, receipt.jobId)).toMatchObject({ state: 'done', result: { counts: { created: 4 } } })
  const prior = listRecordCorrespondences(db, { eventId: 10 }).find(r => r.relationId === exact.observations[0]!.relationAlias)!
  const audit = getRecordCorrespondenceAudit(db, prior.id)
  addSource('LIMIT', { queriedAt: '2026-11-11T00:00:00Z', rawResponse: 'x'.repeat(4 * 1024 * 1024 - bytes + 1) })
  const over = submitCandidateDiscovery(db, { clientRequestId: 'over747', eventIds: [10] }, fixture.root)
  await whenIdle()
  expect(getJob(db, over.jobId)).toMatchObject({ state: 'done' })
  // Same-version business dedupe protects the existing decision; a fresh business exceeds the bound.
  addSource('FRESH', { queriedAt: '2026-11-12T00:00:00Z', rawResponse: 'x'.repeat(4 * 1024 * 1024 - bytes + 1) })
  const fresh = submitCandidateDiscovery(db, { clientRequestId: 'over-fresh747', eventIds: [10] }, fixture.root)
  await whenIdle()
  expect(getJob(db, fresh.jobId)).toMatchObject({ state: 'failed', result: { counts: { created: 0 }, items: [{ errorCode: 'source_materialization_limit' }] } })
  retryCandidateDiscovery(db, fresh.jobId, fixture.root)
  await whenIdle()
  expect(getJob(db, fresh.jobId)).toMatchObject({ state: 'failed', result: { attempt: 2, items: [{ errorCode: 'source_materialization_limit' }] } })
  expect(getRecordCorrespondenceAudit(db, prior.id)).toEqual(audit)
})

it('recovers an unactivated archive task at startup and explicitly retries the same public request', async () => {
  const path = join(fixture.root, 'restart747.sqlite')
  copyFileSync(sqlite.name, path)
  const first = new Database(path); first.pragma('foreign_keys=ON')
  const staging = drizzle(first, { schema })
  const source = addSource('RESTART', {}, staging)
  const [id] = enqueueArchivedCandidates(staging, [source.coordinate], fixture.root, true)
  first.close()
  const next = new Database(path); next.pragma('foreign_keys=ON')
  const restarted = drizzle(next, { schema })
  try {
    expect(ensureJobRunnerReady(restarted)).toBe(1)
    expect(getJob(restarted, id!)).toMatchObject({ state: 'failed', params: { queryId: source.queryAlias } })
    expect(await dispatchCandidateJobMcp('retry', { id }, { db: restarted, filesDir: fixture.root, authorized: true })).toMatchObject({ jobId: id })
    await whenIdle()
    expect(getJob(restarted, id!)).toMatchObject({ state: 'done', result: { attempt: 1, counts: { succeeded: 5 } } })
    expect(enqueueArchivedCandidates(restarted, [source.coordinate], fixture.root, true)).toEqual([id])
  } finally { await whenIdle(); next.close() }
})

it('continues target archive generations beyond 200 events and deduplicates repeated staging', async () => {
  const source = addSource('CONTINUE', { owner: 30 })
  const ids = db.transaction(() => enqueueArchivedCandidates(db, [source.coordinate], fixture.root, true))
  activateCandidateDiscoveryTasks(db, ids, fixture.root)
  await whenIdle()
  const root = getJob(db, ids[0]!)!
  const result = root.result as CandidateJobResult
  expect(root).toMatchObject({ state: 'done', result: { throughEventId: 1200, nextAfterEventId: 1199, items: expect.any(Array), counts: { succeeded: 200, created: 200 } } })
  expect(result.items).toHaveLength(200)
  expect(getJob(db, result.continuationJobId!)).toMatchObject({ state: 'done', params: { archiveGeneration: root.id, queryId: source.queryAlias, afterEventId: 1199, throughEventId: 1200 }, result: { items: [{ eventId: 1200 }], counts: { created: 1 } } })
  const before = listRecordCorrespondences(db).map(row => [row.id, getRecordCorrespondenceAudit(db, row.id)])
  expect(enqueueArchivedCandidates(db, [source.coordinate], fixture.root, true)).toEqual(ids)
  activateCandidateDiscoveryTasks(db, ids, fixture.root)
  await whenIdle()
  expect(listRecordCorrespondences(db).map(row => [row.id, getRecordCorrespondenceAudit(db, row.id)])).toEqual(before)
  const tail = listRecordCorrespondences(db, { eventId: 1200 })[0]!
  expect(tail.status).toBe('confirmed')
  manual(db, 'continuation747-unlink', [{ action: 'decide', correspondenceId: tail.id, expectedRevision: tail.revision, status: 'unlinked' }])
  const oldAudit = getRecordCorrespondenceAudit(db, tail.id)
  const nextSource = addSource('CONTINUE-NEXT', { owner: 30, queriedAt: '2026-11-11T00:00:00Z' })
  const nextIds = enqueueArchivedCandidates(db, [nextSource.coordinate], fixture.root, true)
  expect(nextIds[0]).not.toBe(ids[0])
  activateCandidateDiscoveryTasks(db, nextIds, fixture.root)
  await whenIdle()
  const nextResult = checkpoint(nextIds[0]!)!
  expect(getJob(db, nextIds[0]!)).toMatchObject({ state: 'done', result: { counts: { created: 200, existing: 200 } } })
  expect(getJob(db, nextResult.continuationJobId!)).toMatchObject({ state: 'done', params: { archiveGeneration: nextIds[0], queryId: nextSource.queryAlias }, result: { counts: { created: 1, existing: 1 } } })
  expect(nextResult.continuationJobId).not.toBe(result.continuationJobId)
  expect(getRecordCorrespondenceAudit(db, tail.id)).toEqual(oldAudit)
  expect(enqueueArchivedCandidates(db, [nextSource.coordinate], fixture.root, true)).toEqual(nextIds)
}, 30000)

it('keeps the global runtime guard closed on the migrated synthetic target', () => {
  expect(() => assertExpandRuntime(sqlite)).toThrow('Finalized/offline target schema cannot be opened')
})

it('pages generic business candidates before fact hydration while retaining every observation of the selected version', () => {
  const input = { eventId: 40, queryIds: [601, 602, 603], exportBatchIds: [], ruleVersion: 'generic747', page: 1, pageSize: 1 }
  statements.length = 0
  const first = generateCandidates(db, input)!
  expect(first).toEqual(generateCandidates(fixture.old, input))
  expect(first).toMatchObject({ total: 2, rows: [{ observationRefs: [{ relationId: 601 }, { relationId: 602 }] }] })
  const facts = statements.filter(q => q.includes('"platform_business_projection"."reconciled_province"') && q.includes('where'))
  expect(facts.length).toBeGreaterThan(0)
  expect(facts.every(q => !/\bin\s*\([^)]*\b603\b/.test(q))).toBe(true)
  expect(statements.some(q => q.includes('"candidate_groups"') && /\blimit 1\b/.test(q))).toBe(true)
  expect(generateCandidates(db, { ...input, page: 2 })).toEqual(generateCandidates(fixture.old, { ...input, page: 2 }))
  expect(generateCandidates(db, { ...input, page: 3 })).toMatchObject({ total: 2, rows: [] })
  // Event discovery deliberately uses page/query title, not the generic row-title rule.
  expect(discoverEventArchives(db, { eventId: 40, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 25 })!.total).toBe(0)
})

it('preserves generic later-process roles export-context paging and invalid source IDs', () => {
  const later = { enterpriseId: 40, titleCode: 'specialized_sme', queryIds: [601, 602, 603], exportBatchIds: [], ruleVersion: 'later747', page: 1, pageSize: 1 }
  expect(generateCandidates(db, later)).toEqual(generateCandidates(fixture.old, later))
  expect(generateCandidates(db, later)).toMatchObject({ total: 2, rows: [{ edge: { type: 'later_process', role: 'followup_apply' } }] })
  for (const page of [1, 2, 3]) {
    const input = { eventId: 40, queryIds: later.queryIds, exportBatchIds: [701], ruleVersion: 'export747', page, pageSize: 2 }
    expect(generateCandidates(db, input)).toEqual(generateCandidates(fixture.old, input))
  }
  expect(generateCandidates(db, { ...later, queryIds: [999999] })).toBeNull()
})
