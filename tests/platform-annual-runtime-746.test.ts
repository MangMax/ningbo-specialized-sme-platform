import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { processReaderFixture } from './helpers/process-target-734'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { createOfflineSnapshot } from '../upgrade/offline-snapshot'
import { transferCorrespondence } from '../upgrade/correspondence'
import { readEventAnnualProcess } from '../server/utils/event-annual-process-read'
import { handleEventAnnualProcessRequest, dispatchEventAnnualProcessMcp } from '../server/utils/event-annual-process-api'
import { readAnnualComparisonInputs, readAnnualWriteScope } from '../server/utils/annual-correspondence-read'
import { qualifyAnnualFinal, reconcileAnnualStep } from '../server/utils/annual-correspondence'
import { preflightRecordCorrespondences, commitRecordCorrespondences, listRecordCorrespondences, getRecordCorrespondenceAudit, type CorrespondenceRequest } from '../server/utils/record-correspondence'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { handleAnnualTaskRequest, readAnnualTask, dispatchAnnualTaskMcp } from '../server/utils/annual-correspondence-api'
import { stageAnnualCorrespondence, activateAnnualCorrespondence } from '../server/utils/jobs/annual-correspondence'
import { whenIdle, __resetJobRunner, clearJobSpecs, requestJobCancel } from '../server/utils/job-runner'
import { assertExpandRuntime } from '../db/schema-phase'
import { startHttpFixture } from './helpers/http-fixture'
import { z } from 'zod'

let fixture: Awaited<ReturnType<typeof processReaderFixture>>
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
const statements: string[] = []
beforeAll(async () => {
  fixture = await processReaderFixture(false, source => {
    const old = drizzle(source, { schema })
    old.insert(schema.enterprise).values({ id: 10, name: 'Annual', nameNorm: 'Annual', usccNorm: 'U10' }).run()
    old.insert(schema.record).values({ id: 10, enterpriseId: 10, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U10' }).run()
    old.insert(schema.recordEvent).values([10, 11, 12, 13].map(id => ({ id, recordId: 10, eventType: 'award' as const, year: 2024 }))).run()
    old.insert(schema.recordEvidence).values({ recordEventId: 10, sourceFile: 'synthetic/annual.pdf', page: 1, listNo: 1 }).run()
    for (const [id, key, status, appliedAt, kind, year] of [
      [401, 'EARLY', '终审不通过', '2024-01-01', '申请', 2024],
      [402, 'LATE', '终审通过', '2024-06-01', '申请', 2024],
      [403, 'LATE', '终审通过', '2024-06-01', '申请', 2024],
      [404, 'OTHER', '终审通过', '2025-06-01', '复核', 2025],
      [405, 'LATE', '终审不通过', '2023-06-01', '复核', 2023],
    ] as const) {
      old.insert(schema.platformQuery).values({ id, interface: 'business_list', queryKey: 'U10', rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-${String(id - 400).padStart(2, '0')}T00:00:00Z`, status: 'success' }).run()
      old.insert(schema.platformRelation).values({ id, queryId: id, sequenceNo: 1, relationKey: key, enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Annual', verificationStatus: 'confirmed', matchBasis: 'uscc',
        rawFields: { id: key, sblx: kind, sqsj: appliedAt, cszt: status, year } }).run()
      ensurePlatformObservation(old, id)
    }
    manual(old, 'historical-confirmed', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: 11, relationId: 402, role: 'context_only' } }])
    manual(old, 'historical-rejected', [{ action: 'create', status: 'rejected', edge: { type: 'event_process', eventId: 12, relationId: 405, role: 'context_only' } }])
    const saved = manual(old, 'historical-unlink-create', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: 13, relationId: 405, role: 'context_only' } }])
    manual(old, 'historical-unlink', [{ action: 'decide', correspondenceId: saved.correspondenceIds[0]!, expectedRevision: 2, status: 'unlinked' }])
    for (const id of [20, 30, 40, 50]) {
      old.insert(schema.enterprise).values({ id, name: 'Annual' + id, nameNorm: 'Annual' + id, usccNorm: 'U' + id }).run()
      old.insert(schema.record).values({ id, enterpriseId: id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U' + id }).run()
      old.insert(schema.recordEvent).values({ id, recordId: id, eventType: id === 30 ? 'review' : 'award', year: id === 30 ? 2023 : 2024, decidedYear: id === 30 ? 2026 : null }).run()
    }
    for (const [id, owner, sourceKind, key, year] of [[501, 20, 'apply_list', 'UNKNOWN', 2024], [601, 30, 'apply_list', 'REVIEW', 2026], [602, 30, 'business_list', 'REVIEW', null], [603, 30, 'business_list', 'UNRELATED', 2026]] as const) {
      const rawFields = { id: key, sblx: owner === 30 ? '复核' : '申请', sqsj: owner === 30 ? '2026-01-01' : '2024-01-01', cszt: '终审通过', ...(year === null ? {} : { year: String(year) }) }
      const collectionEvidence = id === 501 ? { source: 'queryList' as const, status: 'partial' as const, effectiveConditions: { combination: 'and' as const }, titleScope: { mode: 'source_default' as const, rdjb: [] }, queriedAt: '2026-10-05T00:00:00Z', completedAt: '2026-10-05T00:01:00Z',
        rows: [rawFields], pages: [{ source: 'queryList' as const, rdjb: null, page: 1, maxPage: 1, status: 'success' as const, fetchedCount: 1, declaredTotal: 2, error: null }], fetchedCount: 1, declaredTotal: 2, completeness: 'partial' as const, fullRange: false, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } : null
      old.insert(schema.platformQuery).values({ id, interface: sourceKind, queryKey: 'U' + owner, rdjb: id === 603 ? '3' : sourceKind === 'business_list' ? '2' : '', titleCode: null, queriedAt: '2026-10-05T00:00:00Z', status: id === 501 ? 'partial' : 'success', collectionEvidence }).run()
      old.insert(schema.platformRelation).values({ id, queryId: id, sequenceNo: 1, relationKey: key, enterpriseId: owner, usccRaw: 'U' + owner, nameRaw: 'Annual' + owner, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields }).run()
      ensurePlatformObservation(old, id)
    }
    old.insert(schema.platformQuery).values({ id: 701, interface: 'business_list', queryKey: 'U50', rdjb: '2', queriedAt: '2026-10-06T00:00:00Z', status: 'success' }).run()
    old.insert(schema.platformRelation).values({ id: 701, queryId: 701, sequenceNo: 1, relationKey: 'STORED', enterpriseId: 50, usccRaw: 'U50', verificationStatus: 'confirmed', status: '终审通过', rawFields: { id: 'STORED', sblx: '申请', sqsj: '2024-01-01', year: 2024, archivedDetail: 'x'.repeat(5000) } }).run()
    ensurePlatformObservation(old, 701)
  })
  const source = join(fixture.root, 'annual-71610.sqlite')
  const target = join(fixture.root, 'annual-71611.sqlite')
  await createOfflineSnapshot(fixture.target, source)
  copyFileSync(source, target)
  transferCorrespondence({ source, target, runId: 'annual746' })
  sqlite = new Database(target, { verbose: query => statements.push(String(query)) })
  sqlite.pragma('foreign_keys=ON')
  db = drizzle(sqlite, { schema })
})

it('refreshes migrated annual decisions and replays without duplicate audit', () => {
  const before = readAnnualWriteScope(db, 10)!
  expect(before.steps).toHaveLength(2)
  const oraclePath = join(fixture.root, 'annual-refresh-oracle.sqlite')
  copyFileSync(fixture.legacySource, oraclePath)
  const oracleSqlite = new Database(oraclePath)
  oracleSqlite.pragma('foreign_keys=ON')
  const oracle = drizzle(oracleSqlite, { schema })
  try {
    const input = { eventId: 10, generation: before.generation, stepId: before.finalCandidateStepId! }
    const first = reconcileAnnualStep(db, readAnnualWriteScope, input)
    expect(first).toEqual(reconcileAnnualStep(oracle, readAnnualWriteScope, input))
    expect(first).toMatchObject({ status: 'created', relationId: 403, decisionRefs: [{ status: 'confirmed', requiresRevalidation: false }] })
    expect(qualifyAnnualFinal(db, readAnnualWriteScope(db, 10)!)).toEqual(qualifyAnnualFinal(oracle, readAnnualWriteScope(oracle, 10)!))
    expect(qualifyAnnualFinal(db, readAnnualWriteScope(db, 10)!)).toMatchObject({ status: 'confirmed', decisionRefs: first.decisionRefs })
    expect(reconcileAnnualStep(db, readAnnualWriteScope, input)).toEqual(reconcileAnnualStep(oracle, readAnnualWriteScope, input))
    expect(reconcileAnnualStep(db, readAnnualWriteScope, input)).toMatchObject({ status: 'existing', decisionRefs: first.decisionRefs })
  } finally { oracleSqlite.close() }
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('reads the complete annual comparison seam and rejects missing selected query closure', () => {
  const request = { enterpriseId: 10, titleCode: 'specialized_sme', eventIds: [10], selectedQueryIds: [401, 402, 403, 404, 405] }
  const old = fixture.old.transaction(() => readAnnualComparisonInputs(fixture.legacy, fixture.old, request))
  const target = db.transaction(() => readAnnualComparisonInputs(sqlite, db, request))
  expect(target.processes).toEqual(old.processes)
  expect(() => db.transaction(() => readAnnualComparisonInputs(sqlite, db, { ...request, selectedQueryIds: [401] }))).toThrow('platform_comparison_scope_unavailable')
})
beforeEach(() => sqlite.exec('SAVEPOINT annual_case'))
afterEach(async () => { await whenIdle(); __resetJobRunner(); clearJobSpecs(); sqlite.exec('ROLLBACK TO annual_case; RELEASE annual_case') })
afterAll(() => { sqlite?.close(); fixture?.close() })

it('reads migrated annual steps final candidate and source generation equal to the old normal service', () => {
  const old = readEventAnnualProcess(fixture.old, 10)!
  expect(old.process.steps.map(step => step.status)).toEqual(['终审不通过', '终审通过'])
  expect(old.process.steps[1]!.groups[0]!.observationRefs.map(ref => ref.relationId)).toEqual([402, 403])
  statements.length = 0
  expect(readEventAnnualProcess(db, 10)).toEqual(old)
  expect(statements.some(query => /\b(?:from|join)\s+"platform_(?:query|relation)"(?:\s|$)/i.test(query))).toBe(false)
  expect(handleEventAnnualProcessRequest({ method: 'GET', id: 10 }, { db })).toEqual(handleEventAnnualProcessRequest({ method: 'GET', id: 10 }, { db: fixture.old }))
  expect(dispatchEventAnnualProcessMcp({ eventId: 10, pageSize: 1 }, { db })).toEqual(dispatchEventAnnualProcessMcp({ eventId: 10, pageSize: 1 }, { db: fixture.old }))
})

function manual(database: typeof db, key: string, operations: CorrespondenceRequest['operations']) {
  const request: CorrespondenceRequest = { idempotencyKey: key, sourceIdentity: 'synthetic746/' + key, actor: { type: 'user', id: 'reviewer' }, basis: 'normal explicit decision', ruleId: 'manual', ruleVersion: '1', operations }
  return commitRecordCorrespondences(database, request, preflightRecordCorrespondences(database, request).planHash)
}
function addSource(key: string, queriedAt = '2026-11-01T00:00:00Z', status = '终审通过') {
  const rawFields = { id: key, sblx: '申请', sqsj: '2024-09-01', cszt: status, year: 2024 }
  return writeNewCollectionTarget(db, { queryText: JSON.stringify({ interface: 'business_list', queryKey: 'U10', rdjb: '2', titleCode: 'specialized_sme', queriedAt, status: 'success', rawResponse: 'normal original evidence',
    relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Annual', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields }] }),
  evidenceText: null, createdAt: queriedAt, assignments: [{ enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Annual', verificationStatus: 'confirmed', matchBasis: 'uscc', origin: 'command', actor: { type: 'user', id: 'reviewer' }, basis: 'exact source identity', recordedAt: queriedAt }] })
}

it.each([{ eventId: 11, status: 'confirmed' }, { eventId: 12, status: 'rejected' }, { eventId: 13, status: 'unlinked' }])('preserves historical $status decisions and independent same-version observations', ({ eventId, status }) => {
  const old = readAnnualWriteScope(fixture.old, eventId)!, target = readAnnualWriteScope(db, eventId)!
  expect(target).toEqual(old)
  const qualification = qualifyAnnualFinal(db, target)
  expect(qualification).toEqual(qualifyAnnualFinal(fixture.old, old))
  expect(qualification).toMatchObject({ status: status === 'confirmed' ? 'confirmed' : 'blocked', decisionRefs: [{ status, relationId: status === 'confirmed' ? 402 : 405 }] })
  const audit = listRecordCorrespondences(db).map(r => [r.id, r.revision, getRecordCorrespondenceAudit(db, r.id)])
  expect(reconcileAnnualStep(db, readAnnualWriteScope, { eventId, generation: target.generation, stepId: target.finalCandidateStepId! }).status).toBe(status === 'confirmed' ? 'existing' : 'protected')
  expect(listRecordCorrespondences(db).map(r => [r.id, r.revision, getRecordCorrespondenceAudit(db, r.id)])).toEqual(audit)
})

it('observes nonidentity external aliases and new source versions on the next request', () => {
  const before = readAnnualWriteScope(db, 10)!
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  const added = addSource('NEW')
  expect(added.queryAlias).not.toBe(added.collectionId)
  expect(added.observations[0]!.relationAlias).not.toBe(added.observations[0]!.observationId)
  const repeated = addSource('NEW', '2026-11-02T00:00:00Z')
  expect(repeated.observations[0]!.versionId).toBe(added.observations[0]!.versionId)
  const fresh = readAnnualWriteScope(db, 10)!
  expect(fresh.generation).not.toBe(before.generation)
  expect(fresh.steps).toHaveLength(3)
  expect(() => reconcileAnnualStep(db, readAnnualWriteScope, { eventId: 10, generation: before.generation, stepId: before.finalCandidateStepId! })).toThrowError(expect.objectContaining({ code: 'source_generation_changed' }))
  const result = reconcileAnnualStep(db, readAnnualWriteScope, { eventId: 10, generation: fresh.generation, stepId: fresh.finalCandidateStepId! })
  expect(result).toMatchObject({ status: 'created', relationId: repeated.observations[0]!.relationAlias, decisionRefs: [{ requiresRevalidation: false }] })
  expect(fresh.steps[2]!.currentRelationIds).toEqual([added.observations[0]!.relationAlias, repeated.observations[0]!.relationAlias])
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('submits executes reads and retries a cancelled annual task through public REST and MCP services', async () => {
  const context = { db, readScope: readAnnualWriteScope, filesDir: fixture.root, browserAuthorized: true }
  const staged = stageAnnualCorrespondence(db, readAnnualWriteScope, { clientRequestId: 'cancel746', eventIds: [10] })
  expect(requestJobCancel(db, staged.jobId)).toMatchObject({ state: 'cancelled' })
  expect(readAnnualTask(db, readAnnualWriteScope, staged.jobId, true)).toMatchObject({ status: 'cancelled', capabilities: { retry: true } })
  expect(await handleAnnualTaskRequest('retry', { method: 'POST', id: staged.jobId }, context)).toMatchObject({ status: 202 })
  await whenIdle()
  expect(await handleAnnualTaskRequest('detail', { method: 'GET', id: staged.jobId }, context)).toMatchObject({ status: 200, body: { status: 'done', result: { attempt: 1, events: [{ outcomes: [{ status: 'created' }, { status: 'created' }], finalQualification: { status: 'confirmed' } }] } } })
  const audit = listRecordCorrespondences(db).map(r => getRecordCorrespondenceAudit(db, r.id))
  const replay = await dispatchAnnualTaskMcp('submit', { clientRequestId: 'replay746', eventIds: [10] }, { ...context, authorized: true })
  expect(replay).toMatchObject({ jobId: staged.jobId })
  expect(listRecordCorrespondences(db).map(r => getRecordCorrespondenceAudit(db, r.id))).toEqual(audit)
})

it('keeps a durable step and detects a normal source update between worker checkpoints', async () => {
  const staged = stageAnnualCorrespondence(db, readAnnualWriteScope, { clientRequestId: 'changing746', eventIds: [10] })
  activateAnnualCorrespondence(db, readAnnualWriteScope, [staged.jobId], fixture.root)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(listRecordCorrespondences(db, { eventId: 10 })).toHaveLength(1)
  addSource('NEXT')
  await whenIdle()
  expect(readAnnualTask(db, readAnnualWriteScope, staged.jobId, true)).toMatchObject({ status: 'failed', capabilities: { retry: false }, result: { events: [{ errorCode: 'source_generation_changed', outcomes: [{ status: 'created' }], finalQualification: { status: 'blocked' } }] } })
  expect(listRecordCorrespondences(db, { eventId: 10 })).toHaveLength(1)
})

it('preserves review business-year lineage title witnesses unknown scope and empty event results', () => {
  for (const id of [20, 30, 40]) expect(readEventAnnualProcess(db, id)).toEqual(readEventAnnualProcess(fixture.old, id))
  expect(readEventAnnualProcess(db, 20)!.process).toMatchObject({ steps: [], scopeGaps: [{ relationId: 501, reasons: ['title_scope_unknown'] }] })
  expect(readEventAnnualProcess(db, 20)!.process.coverageReasons).toEqual(['archive_partial', 'archive_range_incomplete'])
  const review = readEventAnnualProcess(db, 30)!
  expect(review.process).toMatchObject({ businessYear: 2026, declareKind: 'review', steps: [{ year: 2026, declareKind: 'review', annualEligible: true }] })
  expect(review.process.steps[0]!.corroborationRefs).toContainEqual({ field: 'year', fromRelationIds: [601], toRelationIds: [602] })
  expect(readEventAnnualProcess(db, 40)!.process.steps).toEqual([])
  expect(readEventAnnualProcess(db, 999)).toBeNull()
})

it('batches shared annual sources once per submission worker and readback request', async () => {
  const count = () => statements.filter(q => /from "platform_collection" inner join "platform_legacy_query_alias"/i.test(q)).length
  statements.length = 0
  const staged = stageAnnualCorrespondence(db, readAnnualWriteScope, { clientRequestId: 'batch746', eventIds: [10, 11] })
  expect(count()).toBe(1)
  statements.length = 0
  activateAnnualCorrespondence(db, readAnnualWriteScope, [staged.jobId], fixture.root)
  await whenIdle()
  expect(count()).toBe(1)
  statements.length = 0
  expect(readAnnualTask(db, readAnnualWriteScope, staged.jobId, true)).toMatchObject({ status: 'done', result: { events: [{ status: 'done' }, { status: 'done' }] } })
  expect(count()).toBe(1)
  expect(statements.some(q => /\b(?:from|join)\s+"platform_(?:query|relation)"(?:\s|$)/i.test(q))).toBe(false)
})

it('rolls back failed annual preflight and decision writes and retries unfinished durable steps', async () => {
  const before = listRecordCorrespondences(db)
  sqlite.exec("CREATE TRIGGER annual_fail BEFORE INSERT ON record_correspondence WHEN NEW.event_id=10 AND NEW.observation_id=403 BEGIN SELECT RAISE(ABORT,'synthetic annual write failure'); END")
  const scope = readAnnualWriteScope(db, 10)!
  expect(() => reconcileAnnualStep(db, readAnnualWriteScope, { eventId: 10, generation: scope.generation, stepId: scope.finalCandidateStepId! })).toThrow('synthetic annual write failure')
  expect(listRecordCorrespondences(db)).toEqual(before)
  const staged = stageAnnualCorrespondence(db, readAnnualWriteScope, { clientRequestId: 'rollback746', eventIds: [10] })
  activateAnnualCorrespondence(db, readAnnualWriteScope, [staged.jobId], fixture.root)
  await whenIdle()
  expect(readAnnualTask(db, readAnnualWriteScope, staged.jobId, true)).toMatchObject({ status: 'failed', capabilities: { retry: true }, result: { events: [{ outcomes: [{ status: 'created' }], errorCode: 'annual_step_failed' }] } })
  const first = listRecordCorrespondences(db, { eventId: 10 })[0]!
  const audit = getRecordCorrespondenceAudit(db, first.id)
  sqlite.exec('DROP TRIGGER annual_fail')
  expect(await handleAnnualTaskRequest('retry', { method: 'POST', id: staged.jobId }, { db, readScope: readAnnualWriteScope, filesDir: fixture.root, browserAuthorized: true })).toMatchObject({ status: 202 })
  await whenIdle()
  expect(readAnnualTask(db, readAnnualWriteScope, staged.jobId, true)).toMatchObject({ status: 'done', result: { attempt: 2, events: [{ outcomes: [{ status: 'created' }, { status: 'created' }], finalQualification: { status: 'confirmed' } }] } })
  expect(getRecordCorrespondenceAudit(db, first.id)).toEqual(audit)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('confirms a migrated candidate with its revision and honors a competing ordinary rejection', () => {
  const receipt = manual(db, 'candidate746', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: 10, relationId: 401, role: 'context_only' } }])
  const before = listRecordCorrespondences(db, { id: receipt.correspondenceIds[0] })[0]!
  const scope = readAnnualWriteScope(db, 10)!
  expect(reconcileAnnualStep(db, readAnnualWriteScope, { eventId: 10, generation: scope.generation, stepId: scope.steps[0]!.stepId })).toMatchObject({ status: 'created', decisionRefs: [{ id: before.id, revision: 2, requiresRevalidation: false }] })
  expect(listRecordCorrespondences(db, { id: before.id })[0]!.sourceFingerprint).toBe(before.sourceFingerprint)
  const late = manual(db, 'late-candidate746', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: 10, relationId: 403, role: 'context_only' } }]).correspondenceIds[0]!
  const request: CorrespondenceRequest = { idempotencyKey: 'stale746', sourceIdentity: 'synthetic746/stale', actor: { type: 'user', id: 'reviewer' }, basis: 'normal candidate decision', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'decide', correspondenceId: late, expectedRevision: 1, status: 'confirmed' }] }
  const plan = preflightRecordCorrespondences(db, request)
  manual(db, 'competing746', [{ action: 'decide', correspondenceId: late, expectedRevision: 1, status: 'rejected' }])
  expect(() => commitRecordCorrespondences(db, request, plan.planHash)).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
  const audit = getRecordCorrespondenceAudit(db, late)
  expect(reconcileAnnualStep(db, readAnnualWriteScope, { eventId: 10, generation: scope.generation, stepId: scope.finalCandidateStepId! })).toMatchObject({ status: 'protected', decisionRefs: [{ id: late, status: 'rejected', revision: 2 }] })
  expect(getRecordCorrespondenceAudit(db, late)).toEqual(audit)
})

it('keeps the global expand runtime guard closed on the completed synthetic target', () => {
  expect(() => assertExpandRuntime(sqlite)).toThrow('Finalized/offline target schema cannot be opened')
})

it('retains independent other-title metadata in the annual comparison closure', () => {
  const request = { enterpriseId: 30, titleCode: 'specialized_sme', eventIds: [30], selectedQueryIds: [601, 602] }
  const old = fixture.old.transaction(() => readAnnualComparisonInputs(fixture.legacy, fixture.old, request))
  const fresh = db.transaction(() => readAnnualComparisonInputs(sqlite, db, request))
  expect(fresh.processes).toEqual(old.processes)
  expect(fresh.processes[0]!.sourceRefs.titleScopeRefs).toMatchObject([{ relationId: 602 }, { relationId: 603 }])
})

it('preserves the comparison observation facts when a content version has no source status', () => {
  expect(readEventAnnualProcess(db, 50)).toEqual(readEventAnnualProcess(fixture.old, 50))
  expect(readEventAnnualProcess(db, 50)!.process.steps[0]!.status).toBeNull()
  const request = { enterpriseId: 50, titleCode: 'specialized_sme', eventIds: [50], selectedQueryIds: [701] }
  const old = fixture.old.transaction(() => readAnnualComparisonInputs(fixture.legacy, fixture.old, request))
  const fresh = db.transaction(() => readAnnualComparisonInputs(sqlite, db, request))
  expect(fresh.processes).toEqual(old.processes)
  expect(fresh.processes[0]!.input.groups[0]!.observationRefs[0]!.evidence.process).toMatchObject({ status: '终审通过' })
})

it('serves migrated annual reads and background task submission over real HTTP with MCP readback', async () => {
  let taskId = ''
  const apiToken = ['synthetic', 'annual', '746'].join('-')
  const context = { db, readScope: readAnnualWriteScope, filesDir: fixture.root, apiToken }
  const app = await startHttpFixture({ routes: {
    '/annual': request => handleEventAnnualProcessRequest({ ...request, id: 10 }, { db }),
    '/tasks': request => handleAnnualTaskRequest('submit', request, context),
    '/task': request => handleAnnualTaskRequest('detail', { ...request, id: taskId }, context),
  } })
  try {
    const initial = await fetch(app.baseUrl + '/annual?pageSize=1')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ total: 2, process: { finalQualification: { status: 'eligible' }, steps: [{ status: '终审不通过' }] } })
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'http746', eventIds: [10] }) }
    expect((await fetch(app.baseUrl + '/tasks', request)).status).toBe(401)
    const response = await fetch(app.baseUrl + '/tasks', { ...request, headers: { ...request.headers, authorization: 'Bearer ' + apiToken } })
    expect(response.status).toBe(202)
    taskId = z.object({ jobId: z.string() }).parse(await response.json()).jobId
    await whenIdle()
    const detail = await fetch(app.baseUrl + '/task')
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ status: 'done', result: { events: [{ finalQualification: { status: 'confirmed' } }] } })
    expect(await dispatchAnnualTaskMcp('detail', { id: taskId }, { ...context, authorized: true })).toMatchObject({ status: 'done', result: { events: [{ finalQualification: { status: 'confirmed' } }] } })
  } finally { await app.close() }
})
