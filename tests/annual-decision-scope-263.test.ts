import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { useDb, schema as s } from '../db/client'
import { readAnnualDecisionRefs, qualifyAnnualFinal, reconcileAnnualStep, type AnnualWriteScope } from '../server/utils/annual-correspondence'
import { readAnnualWriteScope, enrichAnnualProcessFinalQualification } from '../server/utils/annual-correspondence-read'
import { readEventAnnualProcess } from '../server/utils/event-annual-process-read'
import { readAnnualTask } from '../server/utils/annual-correspondence-api'
import { stageAnnualCorrespondence } from '../server/utils/jobs/annual-correspondence'
import { commitRosterImport } from '../server/utils/roster-import'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceRequest } from '../server/utils/record-correspondence'
import * as validity from '../server/utils/record-correspondence-ref-validity'
import { __resetJobRunner, clearJobSpecs, whenIdle } from '../server/utils/job-runner'

const cleanup: (() => void)[] = []
afterEach(async () => {
  await whenIdle(); vi.restoreAllMocks(); __resetJobRunner(); clearJobSpecs()
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'annual-scope-263-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = useDb({ dbPath: join(dir, 'synthetic.db') })
  cleanup.push(() => db.$client.close())
  __resetJobRunner(); clearJobSpecs()
  const enterprise = db.insert(s.enterprise).values({ name: '年度目标合成企业', nameNorm: '年度目标合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  let serial = 0
  const add = (options: { year?: number; kind?: 'apply' | 'review'; status?: string; rawStatus?: boolean } = {}) => {
    const n = ++serial, year = options.year ?? 2024, status = options.status ?? '终审通过'
    const query = db.insert(s.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-24T00:${String(n).padStart(2, '0')}:00Z`, status: 'success', rawResponse: 'immutable synthetic archive' }).returning().get()
    const relation = db.insert(s.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: 'BUS-SAME', enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, year, declareKind: options.kind ?? 'apply', status, appliedAt: '2024-06-01', verificationStatus: 'confirmed', rawFields: {
      id: 'BUS-SAME', sblx: options.kind === 'review' ? '复核' : '申请', year, sqsj: '2024-06-01', ...(options.rawStatus === false ? {} : { cszt: status }),
    } }).returning().get()
    expect(commitRosterImport(db, { idempotencyKey: `scope-projection-${n}`, sourceKind: 'platform_archive', sourceIdentity: 'synthetic/263', payload: { platformRecordObservations: [{ relationId: relation.id }] } }).status).toBe('committed')
    return { query, relation }
  }
  let command = 0
  const save = (operations: CorrespondenceRequest['operations']) => {
    const request: CorrespondenceRequest = { idempotencyKey: `scope-decision-${++command}`, sourceIdentity: 'synthetic/263', actor: { type: 'user', id: 'reviewer' }, basis: 'explicit synthetic decision', ruleId: 'manual', ruleVersion: '1', operations }
    return commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash)
  }
  const decide = (relationId: number, status: 'candidate' | 'confirmed' | 'rejected' = 'confirmed', eventId = event.id, role: 'context_only' | 'supports_award' = 'context_only') =>
    save([{ action: 'create', status, edge: { type: 'event_process', eventId, relationId, role } }]).correspondenceIds[0]!
  const foreign = (relationId: number, count: number, status: 'confirmed' | 'rejected' = 'confirmed') => {
    const events = Array.from({ length: count }, (_, i) => db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, batchSeq: i + 10 }).returning().get())
    if (events.length) save(events.map(e => ({ action: 'create', status, edge: { type: 'event_process', eventId: e.id, relationId, role: 'context_only' } })))
  }
  const scope = () => readAnnualWriteScope(db, event.id)!
  return { db, event, enterprise, record, add, save, decide, foreign, scope }
}
/** The pre-263 algorithm: unscoped validity followed by the exact target filter.
 * This remains a real SQLite/validity read, not a synthetic response oracle. */
function legacyRefs(db: ReturnType<typeof useDb>, ids: number[], scope: AnnualWriteScope) {
  return readAnnualDecisionRefs(db, ids).filter(r => r.eventId === scope.eventId && r.enterpriseId === scope.enterpriseId && r.titleCode === scope.titleCode &&
    (r.role === 'context_only' || r.role === (scope.declareKind === 'apply' ? 'supports_award' : 'supports_review')))
}
function meter() {
  const original = validity.correspondenceRefValidity, batches: number[][] = []
  const spy = vi.spyOn(validity, 'correspondenceRefValidity').mockImplementation((db, ids) => {
    batches.push([...ids]); return original(db, ids)
  })
  return { batches, ids: () => batches.flat(), restore: () => spy.mockRestore() }
}

it('validates only the current target as foreign events grow while matching the complete legacy read', () => {
  const f = fixture(), source = f.add(), id = f.decide(source.relation.id)
  let previous = 0
  for (const size of [0, 201, 401]) {
    f.foreign(source.relation.id, size - previous); previous = size
    const scope = f.scope(), expected = legacyRefs(f.db, [source.relation.id], scope)
    const observed = meter()
    try {
      const actual = readAnnualDecisionRefs(f.db, [source.relation.id], scope)
      console.log(JSON.stringify({ case: '263-scale', foreignEvents: size, validityRows: observed.ids().length, validityCalls: observed.batches.length }))
      expect(observed.ids()).toEqual([id])
      expect(actual).toEqual(expected)
      expect(actual[0]).toMatchObject({ id, eventId: f.event.id, requiresRevalidation: false })
    } finally { observed.restore() }
  }
  // No-scope consumers keep all original observation-local decisions.
  expect(readAnnualDecisionRefs(f.db, [source.relation.id])).toHaveLength(402)
})

it('pushes every existing target predicate before validity without changing null or review role selection', () => {
  const f = fixture(), source = f.add()
  const context = f.decide(source.relation.id), support = f.decide(source.relation.id, 'confirmed', f.event.id, 'supports_award')
  const base = f.scope()
  for (const target of [base, { ...base, declareKind: 'review' as const }, { ...base, declareKind: null }, { ...base, enterpriseId: base.enterpriseId + 1000 }, { ...base, titleCode: 'innovative_sme' }]) {
    const expected = legacyRefs(f.db, [source.relation.id], target)
    const observed = meter()
    try {
      expect(readAnnualDecisionRefs(f.db, [source.relation.id], target)).toEqual(expected)
      expect(observed.ids()).toEqual(expected.map(r => r.id))
    } finally { observed.restore() }
  }
  expect(legacyRefs(f.db, [source.relation.id], base).map(r => r.id)).toEqual([context, support])
  expect(legacyRefs(f.db, [source.relation.id], { ...base, declareKind: null }).map(r => r.id)).toEqual([context])
  const observed = meter()
  try { expect(readAnnualDecisionRefs(f.db, [], base)).toEqual([]); expect(observed.ids()).toEqual([]) } finally { observed.restore() }
})

it('keeps full qualification receipt and enrichment responses while validating current-target rows only', () => {
  const f = fixture(), source = f.add(), id = f.decide(source.relation.id)
  // Explicit confirmed creation has revision 2; only identity comes from the fixture.
  const confirmedRef = { id, relationId: source.relation.id, revision: 2, status: 'confirmed', requiresRevalidation: false }
  const scope = f.scope(), before = qualifyAnnualFinal(f.db, scope)
  const task = stageAnnualCorrespondence(f.db, readAnnualWriteScope, { clientRequestId: 'scope-readback', eventIds: [f.event.id] })
  const receipt = readAnnualTask(f.db, readAnnualWriteScope, task.jobId, false)
  f.foreign(source.relation.id, 401, 'rejected')
  const fresh = f.scope(), raw = readEventAnnualProcess(f.db, f.event.id)!
  expect(fresh.generation).toBe(scope.generation)
  const expectedRefs = legacyRefs(f.db, [source.relation.id], fresh)
  const expectedQualification = { ...before, decisionRefs: expectedRefs.map(({ id, relationId, revision, status, requiresRevalidation }) => ({ id, relationId, revision, status, requiresRevalidation })) }
  // Keep these extra reads outside the measured consumer calls below.
  expect.soft(readAnnualDecisionRefs(f.db, [source.relation.id], fresh), 'scoped confirmed revision').toMatchObject([confirmedRef])
  expect.soft(readAnnualDecisionRefs(f.db, [source.relation.id]).find(ref => ref.id === id), 'unscoped confirmed revision').toMatchObject(confirmedRef)
  const observed = meter()
  try {
    const qualification = qualifyAnnualFinal(f.db, fresh)
    expect(qualification).toEqual(expectedQualification)
    expect.soft(qualification, 'qualification confirmed revision').toMatchObject({ status: 'confirmed', decisionRefs: [confirmedRef] })
    expect(observed.ids()).toEqual([id]); observed.batches.length = 0
    const readback = readAnnualTask(f.db, readAnnualWriteScope, task.jobId, false)
    expect(readback).toEqual(receipt)
    expect.soft(readback?.result?.events.find(event => event.eventId === f.event.id)?.finalQualification, 'task confirmed revision').toMatchObject({ status: 'confirmed', decisionRefs: [confirmedRef] })
    expect(observed.ids()).toEqual([id]); observed.batches.length = 0
    const enriched = enrichAnnualProcessFinalQualification(f.db, raw)
    expect(enriched).toEqual({ ...raw, process: { ...raw.process, finalQualification: { ...expectedQualification, decisionRefs: expectedRefs } } })
    expect.soft(enriched.process.finalQualification, 'enrichment confirmed revision').toMatchObject({ status: 'confirmed', decisionRefs: [confirmedRef] })
    expect(observed.ids()).toEqual([id, id]); observed.batches.length = 0
    expect(reconcileAnnualStep(f.db, readAnnualWriteScope, { eventId: f.event.id, generation: fresh.generation, stepId: fresh.steps[0]!.stepId })).toEqual({ stepId: fresh.steps[0]!.stepId, status: 'existing', relationId: source.relation.id, decisionRefs: expectedQualification.decisionRefs, reasons: [] })
    expect(observed.ids()).toEqual([id])
  } finally { observed.restore() }
})

it.each(['rejected', 'unlinked'] as const)('retains same-event historical %s protection outside the current annual facts', status => {
  const f = fixture(), old = f.add({ year: 2023, kind: 'review' }), current = f.add()
  const id = f.decide(old.relation.id, status === 'rejected' ? 'rejected' : 'confirmed')
  if (status === 'unlinked') f.save([{ action: 'decide', correspondenceId: id, expectedRevision: 2, status: 'unlinked' }])
  f.foreign(current.relation.id, 20, 'rejected')
  const scope = f.scope(), before = f.db.select().from(s.recordCorrespondenceAudit).all()
  expect(scope.steps[0]!.currentRelationIds).toEqual([current.relation.id])
  expect(scope.steps[0]!.protectionRelationIds).toContain(old.relation.id)
  const observed = meter()
  try {
    const protectedStep = reconcileAnnualStep(f.db, readAnnualWriteScope, { eventId: f.event.id, generation: scope.generation, stepId: scope.steps[0]!.stepId })
    expect(protectedStep).toMatchObject({ status: 'protected', decisionRefs: [{ id, status }] })
    if (status === 'unlinked') expect.soft(protectedStep.decisionRefs, 'protected unlinked revision').toMatchObject([{ id, relationId: old.relation.id, revision: 3, status: 'unlinked' }])
    expect(observed.ids()).toEqual([id]); observed.batches.length = 0
    const qualification = qualifyAnnualFinal(f.db, scope)
    expect(qualification).toMatchObject({ status: 'blocked', reasons: ['protected_decision'], decisionRefs: [{ id, status }] })
    if (status === 'unlinked') expect.soft(qualification.decisionRefs, 'qualification unlinked revision').toMatchObject([{ id, relationId: old.relation.id, revision: 3, status: 'unlinked' }])
    expect(observed.ids()).toEqual([id])
  } finally { observed.restore() }
  expect(f.db.select().from(s.recordCorrespondenceAudit).all()).toEqual(before)
})

it('continues validating current source fingerprints and blocks stale current-target confirmation', () => {
  const f = fixture(), source = f.add(), id = f.decide(source.relation.id)
  f.foreign(source.relation.id, 20)
  f.db.update(s.platformQuery).set({ rawResponse: 'changed synthetic source' }).where(eq(s.platformQuery.id, source.query.id)).run()
  const scope = f.scope(), expected = legacyRefs(f.db, [source.relation.id], scope), observed = meter()
  try {
    expect(readAnnualDecisionRefs(f.db, [source.relation.id], scope)).toEqual(expected)
    expect(expected).toMatchObject([{ id, requiresRevalidation: true }])
    expect(observed.ids()).toEqual([id]); observed.batches.length = 0
    expect(qualifyAnnualFinal(f.db, scope)).toMatchObject({ status: 'blocked', reasons: ['source_requires_revalidation'] })
    expect(observed.ids()).toEqual([id])
  } finally { observed.restore() }
})

it('does not inherit confirmation for a new content version', () => {
  const f = fixture(), old = f.add({ status: '终审不通过', rawStatus: true }), oldId = f.decide(old.relation.id)
  const current = f.add({ rawStatus: true }), scope = f.scope(), oldRow = f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id, oldId)).get()
  f.foreign(current.relation.id, 20)
  expect(qualifyAnnualFinal(f.db, scope)).toMatchObject({ status: 'eligible', decisionRefs: [] })
  const result = reconcileAnnualStep(f.db, readAnnualWriteScope, { eventId: f.event.id, generation: scope.generation, stepId: scope.steps[0]!.stepId })
  expect(result).toMatchObject({ status: 'created', decisionRefs: [{ relationId: current.relation.id, requiresRevalidation: false }] })
  expect(f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id, oldId)).get()).toEqual(oldRow)
})

it('does not inherit an old stored status when the same content version has no typed status', () => {
  const f = fixture(), old = f.add({ status: '终审不通过', rawStatus: false }), oldId = f.decide(old.relation.id)
  const current = f.add({ rawStatus: false }), scope = f.scope(), oldRow = f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id, oldId)).get()
  f.foreign(current.relation.id, 20)
  expect(scope.steps[0]!.reasons).toContain('latest_status_missing')
  expect(qualifyAnnualFinal(f.db, scope)).toMatchObject({ stepId: null, status: 'none', decisionRefs: [] })
  expect(f.db.select().from(s.recordCorrespondence).where(eq(s.recordCorrespondence.id, oldId)).get()).toEqual(oldRow)
})
