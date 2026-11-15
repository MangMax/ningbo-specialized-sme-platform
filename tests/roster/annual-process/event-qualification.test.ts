import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import type { EventAnnualProcessPage } from '../../../lib/roster/annual-process'
import * as annualReader from '../../../server/utils/event-annual-process-read'
import { enrichAnnualProcessFinalQualification, readAnnualWriteScope } from '../../../server/utils/annual-correspondence-read'
import { reconcileAnnualStep } from '../../../server/utils/annual-correspondence'
import { handleEventAnnualProcessRequest, dispatchEventAnnualProcessMcp } from '../../../server/utils/event-annual-process-api'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../../../server/utils/record-correspondence'

const fixtures: Array<{ dir: string; db: ReturnType<typeof initializeDb>; readonly?: ReturnType<typeof initializeDb> }> = []
afterEach(() => vi.restoreAllMocks())
afterAll(() => fixtures.forEach(f => { f.readonly?.$client.close(); f.db.$client.close(); rmSync(f.dir, { recursive: true, force: true }) }))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'annual-qualification-258-')), dbPath = join(dir, 'isolated.db')
  const db = initializeDb({ create: true,  dbPath })
  const enterprise = db.insert(s.enterprise).values({ name: '合成同快照企业', nameNorm: '合成同快照企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  let serial = 0
  function add(options: { key?: string; year?: number; appliedAt?: string; status?: string } = {}) {
    const n = ++serial, key = options.key ?? `SQ-${n}`, year = options.year ?? 2024, appliedAt = options.appliedAt ?? '2024-03-01 09:00:00', status = options.status ?? '终审通过'
    const seeded = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, titleCode: 'specialized_sme', rdjb: '2', queriedAt: `2026-10-01T00:00:${String(n).padStart(2, '0')}Z`, status: 'success', rawResponse: 'Synthetic annual source', relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: key, sblx: '申请', year, sqsj: appliedAt, cszt: status } }] })
    const relation = { id: seeded.relationIds[0]! }
    return relation
  }
  const confirm = (eventId = event.id) => {
    const scope = readAnnualWriteScope(db, eventId)!
    return reconcileAnnualStep(db, readAnnualWriteScope, { eventId, generation: scope.generation, stepId: scope.finalCandidateStepId! })
  }
  const reject = (relationId: number, eventId = event.id) => {
    const request = { idempotencyKey: `reject-${relationId}`, sourceIdentity: 'tests/annual-258/manual', actor: { type: 'user' as const, id: 'fixture' }, basis: 'synthetic explicit decision', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'rejected' as const, edge: { type: 'event_process' as const, eventId, relationId, role: 'context_only' as const } }] }
    return commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash)
  }
  const unlink = (id: number, revision: number) => {
    const request = { idempotencyKey: `unlink-${id}`, sourceIdentity: 'tests/annual-258/manual', actor: { type: 'user' as const, id: 'fixture' }, basis: 'synthetic unlink', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'decide' as const, correspondenceId: id, expectedRevision: revision, status: 'unlinked' as const }] }
    return commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash)
  }
  const readonly = initializeDb({ create: true,  dbPath, readOnly: true }); readonly.$client.pragma('query_only=ON')
  fixtures.push({ dir, db, readonly })
  const read = (query: Record<string, unknown> = {}) => {
    const output = handleEventAnnualProcessRequest({ method: 'GET', id: event.id, query }, { db: readonly })
    expect(output.status).toBe(200)
    return output.body as EventAnnualProcessPage
  }
  return { dir, dbPath, db, readonly, enterprise, record, event, add, confirm, reject, unlink, read }
}
function writeState(db: ReturnType<typeof initializeDb>) {
  return { jobs: db.select().from(s.job).all(), batches: db.select().from(s.importBatch).all(), receipts: db.select().from(s.importReceipt).all(), correspondences: db.select().from(s.recordCorrespondence).all(), audit: db.select().from(s.recordCorrespondenceAudit).all(), proofs: db.select().from(s.comparisonScopeProof).all(), proofAudit: db.select().from(s.comparisonScopeProofAudit).all() }
}

it('publishes actual confirmed qualification before display pagination with the same generation source refs and off-page latest summary', () => {
  const f = fixture()
  f.add({ status: '终审不通过' })
  const latest = f.add({ appliedAt: '2024-12-13 10:00:00' })
  const receipt = f.confirm(); expect(receipt.status).toBe('created')
  const complete = annualReader.readEventAnnualProcess(f.readonly, f.event.id)!
  const body = f.read({ pageSize: 1 })
  expect(body.total).toBe(2); expect(body.process.steps).toHaveLength(1)
  expect(body.process.finalQualification).toMatchObject({ status: 'confirmed', stepId: complete.process.finalCandidateStepId, decisionRefs: [{ relationId: latest.id, requiresRevalidation: false }] })
  expect(body.process.steps[0]!.id).not.toBe(body.process.finalQualification!.stepId)
  expect(body.process.latestStepSummary).toEqual(complete.process.latestStepSummary)
  expect(body.sourceGeneration).toBe(complete.sourceGeneration)
  expect(body.sourceRefs).toEqual(complete.sourceRefs)
  expect(body.process.steps[0]!.groups.flatMap(g => g.observationRefs.flatMap(r => r.existingCorrespondences))).toEqual([])
})

it.each(['blocked', 'none', 'eligible'] as const)('publishes current %s qualification from actual decisions rather than a done task', status => {
  const f = fixture()
  if (status !== 'none') { const row = f.add(); if (status === 'blocked') f.reject(row.id) }
  f.db.insert(s.job).values({ id: 'synthetic-done-258', kind: 'event-annual-correspondence', state: 'done', params: { eventIds: [f.event.id] }, result: { events: [{ eventId: f.event.id, finalQualification: { status: 'confirmed' } }] } }).run()
  const body = f.read()
  expect(body.process.finalQualification).toMatchObject({ status })
  expect(body.process.finalQualification!.reasons).toContain(status === 'blocked' ? 'protected_decision' : status === 'none' ? 'no_annual_process' : 'decision_required')
  const wire = dispatchEventAnnualProcessMcp({ eventId: f.event.id }, { db: f.readonly })
  expect(wire).toEqual(body)
})

it('blocks independent enrichment of an old read after another connection commits a later business without replacing the old source set', () => {
  const f = fixture(); f.add(); f.confirm()
  const old = annualReader.readEventAnnualProcess(f.readonly, f.event.id)!, original = structuredClone(old)
  const later = f.add({ appliedAt: '2024-12-13 10:00:00', status: '终审不通过' })
  const fresh = annualReader.readEventAnnualProcess(f.readonly, f.event.id)!
  expect(fresh.sourceGeneration).not.toBe(old.sourceGeneration)
  expect(fresh.sourceRefs.observations.some(r => r.relationId === later.id)).toBe(true)
  const enriched = enrichAnnualProcessFinalQualification(f.readonly, old)
  expect(enriched.process.finalQualification).toEqual({ stepId: null, status: 'blocked', decisionRefs: [], reasons: ['source_generation_changed'] })
  expect(enriched.sourceGeneration).toBe(old.sourceGeneration)
  expect(enriched.sourceRefs).toEqual(old.sourceRefs)
  expect(old).toEqual(original)
})

it.each(['later-business', 'manual-unlink'])('keeps annual source and decision qualification in one snapshot while another WAL connection commits %s after source read', change => {
  const f = fixture(); const original = f.add(); const receipt = f.confirm()
  const before = annualReader.readEventAnnualProcess(f.readonly, f.event.id)!
  const actualRead = annualReader.readEventAnnualProcess, transactions: boolean[] = [], generations: string[] = []
  let added = false
  const spy = vi.spyOn(annualReader, 'readEventAnnualProcess').mockImplementation((db, eventId) => {
    transactions.push(f.readonly.$client.inTransaction)
    const result = actualRead(db, eventId)
    generations.push(result!.sourceGeneration)
    if (!added) {
      added = true
      if (change === 'later-business') f.add({ appliedAt: '2024-12-13 10:00:00', status: '终审不通过' })
      else f.unlink(receipt.decisionRefs[0]!.id, receipt.decisionRefs[0]!.revision)
    }
    return result
  })
  const body = f.read()
  // The public adapter owns one snapshot; independent enrichment still rechecks
  // its generation, while this path reuses its already-read annual source.
  expect(spy).toHaveBeenCalledTimes(1)
  spy.mockRestore()
  expect(body.process.finalQualification).toMatchObject({ status: 'confirmed', decisionRefs: [{ relationId: original.id, requiresRevalidation: false }] })
  expect(transactions).toEqual([true])
  expect(generations).toEqual([before.sourceGeneration])
  expect(body.sourceGeneration).toBe(before.sourceGeneration); expect(body.sourceRefs).toEqual(before.sourceRefs)
  const after = f.read()
  if (change === 'later-business') {
    expect(after.sourceGeneration).not.toBe(before.sourceGeneration)
    expect(after.process.latestStepSummary).toMatchObject({ status: '终审不通过', appliedAt: '2024-12-13 10:00:00' })
    expect(after.process.finalQualification).toMatchObject({ status: 'none' })
  } else {
    expect(after.sourceGeneration).toBe(before.sourceGeneration)
    expect(after.process.finalQualification).toMatchObject({ status: 'blocked', reasons: ['protected_decision'], decisionRefs: [{ status: 'unlinked', relationId: original.id }] })
  }
})

it('repeats query-only GET and MCP reads without creating jobs plans ledger audit or proof writes', () => {
  const f = fixture(); f.add(); f.confirm()
  const before = writeState(f.db), changes = f.readonly.$client.prepare('select total_changes() n').get()
  const first = f.read()
  expect(first.process.finalQualification!.status).toBe('confirmed')
  for (let n = 0; n < 3; n++) {
    expect(f.read()).toEqual(first)
    expect(dispatchEventAnnualProcessMcp({ eventId: f.event.id }, { db: f.readonly })).toEqual(first)
  }
  expect(f.readonly.$client.prepare('select total_changes() n').get()).toEqual(changes)
  expect(writeState(f.db)).toEqual(before)
})
