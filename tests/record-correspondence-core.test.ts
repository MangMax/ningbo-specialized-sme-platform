import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { commitComparisonScopeProofs, preflightComparisonScopeProofs, type ProofRequest } from '../server/utils/comparison-scope-proof'
import {
  commitRecordCorrespondences,
  CorrespondenceError,
  getRecordCorrespondenceAudit,
  listRecordCorrespondences,
  preflightRecordCorrespondences,
  readRecordCorrespondenceBatch,
  type CorrespondenceOperation,
  type CorrespondenceRequest,
  type CorrespondenceEdge,
} from '../server/utils/record-correspondence'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-correspondence-'))
  dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'test.db') })
  const enterprise = db.insert(schema.enterprise).values({ name: '甲公司', nameNorm: '甲公司', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2022, batchSeq: 2 }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00.000Z', status: 'success', rawResponse: '<tr>original</tr>' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: '甲公司', relationKey: 'B-1', rawFields: { original: '原文' }, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
  return { db, enterprise, record, event, query, relation, dbPath: join(dir, 'test.db') }
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
function request(key: string, operations: CorrespondenceOperation[]): CorrespondenceRequest {
  return { idempotencyKey: key, sourceIdentity: 'synthetic/' + key, actor: { type: 'user', id: 'reviewer' }, basis: 'explicit source-row review', ruleId: 'manual', ruleVersion: '1', operations }
}
function save(db: ReturnType<typeof useDb>, req: CorrespondenceRequest) {
  const plan = preflightRecordCorrespondences(db, req)
  return commitRecordCorrespondences(db, req, plan.planHash)
}
function recognizedProofFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-correspondence-proof-'))
  dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'synthetic.db') })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成甲', nameNorm: '合成甲', usccNorm: '91330211255994475A' }).returning().get()
  const conditions = { combination: 'and' }
  const collection = { source: 'queryBusList', status: 'success', effectiveConditions: conditions, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:01:00Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as typeof schema.platformQuery.$inferInsert.collectionEvidence
  const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'all', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'success', collectionEvidence: collection }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: '合成甲', verificationStatus: 'confirmed' }).returning().get()
  const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported' }).returning().get()
  const exportRow = db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: enterprise.usccNorm, nameRaw: '合成甲' }).returning().get()
  const freeze = db.insert(schema.storedFile).values({ relPath: 'synthetic/freeze-v1', filename: 'freeze-v1.txt', ext: 'txt', bytes: 24, sha256: 'c'.repeat(64), source: 'miit', kind: 'export' }).returning().get()
  const proofRequest: ProofRequest = { idempotencyKey: 'valid-current-proof', sourceIdentity: 'synthetic/current-snapshot', actor: { type: 'agent', id: 'proof-reviewer' }, basis: 'Archived query and export cover the same synthetic freeze', ruleId: 'manual-scope', ruleVersion: '1', operations: [{ action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: { queryId: query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256', scope: { queryAccount: 'synthetic-account', exportAccount: 'synthetic-account', queryRegion: 'synthetic-region', exportRegion: 'synthetic-region', queryFilters: conditions, exportFilters: conditions, windowStart: '2026-10-18T00:00:00Z', windowEnd: '2026-10-18T23:59:59Z', platformVersion: 'freeze-v1', freezeReference: freeze.relPath, freezeFileId: freeze.id, freezeSha256: freeze.sha256! } } }] }
  const proofPlan = preflightComparisonScopeProofs(db, proofRequest)
  const proofId = commitComparisonScopeProofs(db, proofRequest, proofPlan.planHash).proofIds[0]!
  const edge: CorrespondenceEdge = { type: 'recognized_export', relationId: relation.id, exportRowId: exportRow.id, role: 'same_current_row' }
  return { db, proofId, proofRequest, exportRow, edge }
}

describe('record correspondence core', () => {
  it('confirms a proof-backed recognized-export candidate with omitted IDs and retains its provenance and audit', () => {
    const { db, proofId, exportRow, edge } = recognizedProofFixture()
    const candidate = { ...request('proof-candidate', [{ action: 'create', status: 'candidate', edge }]), proofIds: [proofId] }
    const id = save(db, candidate).correspondenceIds[0]!
    const confirm = request('proof-confirm-omitted', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }])
    expect(() => preflightRecordCorrespondences(db, { ...confirm, proofIds: [] })).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    expect(() => preflightRecordCorrespondences(db, { ...confirm, proofIds: [proofId + 999] })).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    const plan = preflightRecordCorrespondences(db, confirm)
    db.update(schema.platformExportRow).set({ nameRaw: 'changed after preflight' }).where(eq(schema.platformExportRow.id, exportRow.id)).run()
    expect(() => commitRecordCorrespondences(db, confirm, plan.planHash)).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    expect(listRecordCorrespondences(db)[0]).toMatchObject({ status: 'candidate', revision: 1, provenance: { comparisonProofIds: [proofId] } })
    expect(getRecordCorrespondenceAudit(db, id)).toHaveLength(1)
    db.update(schema.platformExportRow).set({ nameRaw: '合成甲' }).where(eq(schema.platformExportRow.id, exportRow.id)).run()
    const refreshed = preflightRecordCorrespondences(db, confirm)
    commitRecordCorrespondences(db, confirm, refreshed.planHash)
    expect(listRecordCorrespondences(db)[0]).toMatchObject({ status: 'confirmed', revision: 2, requiresRevalidation: false, provenance: { comparisonProofIds: [proofId] } })
    expect(getRecordCorrespondenceAudit(db, id).at(-1)?.evidence).toMatchObject({ comparisonProofIds: [proofId] })
  })

  it('confirms a proof-backed recognized-export candidate with explicit IDs through the service', () => {
    const { db, proofId, edge } = recognizedProofFixture()
    const id = save(db, { ...request('explicit-proof-candidate', [{ action: 'create', status: 'candidate', edge }]), proofIds: [proofId] }).correspondenceIds[0]!
    const confirm = { ...request('explicit-proof-confirm', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }]), proofIds: [proofId] }
    save(db, confirm)
    expect(listRecordCorrespondences(db)[0]).toMatchObject({ status: 'confirmed', requiresRevalidation: false, provenance: { comparisonProofIds: [proofId] } })
    expect(getRecordCorrespondenceAudit(db, id).at(-1)?.evidence).toMatchObject({ comparisonProofIds: [proofId] })
  })

  it('rejects omitted and explicit revoked proof IDs without changing the candidate', () => {
    const { db, proofId, proofRequest, edge } = recognizedProofFixture()
    const id = save(db, { ...request('revoked-proof-candidate', [{ action: 'create', status: 'candidate', edge }]), proofIds: [proofId] }).correspondenceIds[0]!
    const revoke: ProofRequest = { ...proofRequest, idempotencyKey: 'revoke-current-proof', sourceIdentity: 'synthetic/revoke-current-snapshot', operations: [{ action: 'decide', proofId, expectedRevision: 2, status: 'revoked' }] }
    const revokePlan = preflightComparisonScopeProofs(db, revoke)
    commitComparisonScopeProofs(db, revoke, revokePlan.planHash)
    const confirm = request('revoked-proof-confirm', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }])
    expect(() => preflightRecordCorrespondences(db, confirm)).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    expect(() => preflightRecordCorrespondences(db, { ...confirm, proofIds: [proofId] })).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    expect(listRecordCorrespondences(db)[0]).toMatchObject({ status: 'candidate', revision: 1, provenance: { comparisonProofIds: [proofId] } })
    expect(getRecordCorrespondenceAudit(db, id)).toHaveLength(1)
  })
  it('preflights and commits a row-level candidate with audit and original source readback', () => {
    const { db, event, relation } = fixture()
    const request = {
      idempotencyKey: 'candidate-1', sourceIdentity: 'synthetic-case-1',
      actor: { type: 'agent' as const, id: 'test-agent' }, basis: 'same USCC and title, event batch needs review',
      ruleId: 'row-candidate', ruleVersion: '1',
      operations: [{ action: 'create' as const, status: 'candidate' as const, edge: { type: 'event_process' as const, eventId: event.id, relationId: relation.id, role: 'context_only' as const } }],
    }
    const plan = preflightRecordCorrespondences(db, request)
    expect(plan.batchStatus).toBe('preflight')
    expect(JSON.stringify(plan.targets)).not.toContain('<tr>original</tr>')
    expect(plan.impact).toEqual({ created: 1, unlinked: 0, audit: 1 })
    const receipt = commitRecordCorrespondences(db, request, plan.planHash)
    expect(receipt.impact).toEqual(plan.impact)
    const [edge] = listRecordCorrespondences(db, { eventId: event.id })
    expect(edge).toMatchObject({ id: receipt.correspondenceIds[0], type: 'event_process', status: 'candidate', revision: 1, role: 'context_only' })
    expect(edge?.provenance).toMatchObject({ relation: { sequenceNo: 1, rawFields: { original: '原文' } }, query: { rawResponse: '<tr>original</tr>' } })
    expect(getRecordCorrespondenceAudit(db, edge!.id)).toMatchObject([{ fromStatus: null, toStatus: 'candidate', actorId: 'test-agent', basis: request.basis, idempotencyKey: 'candidate-1' }])
  })

  it('keeps all six typed row roles separate and preserves unlinked source rows', () => {
    const { db, enterprise, event, relation } = fixture()
    const recognizedQuery = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T01:00:00.000Z', status: 'success' }).returning().get()
    const recognized = db.insert(schema.platformRelation).values({ queryId: recognizedQuery.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, rawFields: { recognized: '原值' }, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    const exportBatch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'synthetic-sha', importStatus: 'imported' }).returning().get()
    const exported = db.insert(schema.platformExportRow).values({ batchId: exportBatch.id, sourceRowNo: 7, usccRaw: enterprise.usccNorm, rawFields: { export: '原值' } }).returning().get()
    const extra = db.insert(schema.platformRelation).values({ queryId: recognizedQuery.id, sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, rawFields: { untouched: true }, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    const request = {
      idempotencyKey: 'six-roles', sourceIdentity: 'synthetic-six', actor: { type: 'user' as const, id: 'tester' }, basis: 'row evidence checked', ruleId: 'manual', ruleVersion: '1',
      operations: [
        { action: 'create' as const, status: 'candidate' as const, edge: { type: 'event_process' as const, eventId: event.id, relationId: relation.id, role: 'context_only' as const } },
        { action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId: event.id, relationId: recognized.id, role: 'recognized_corrob' as const } },
        { action: 'create' as const, status: 'confirmed' as const, edge: { type: 'later_process' as const, enterpriseId: enterprise.id, titleCode: 'specialized_sme', relationId: relation.id, role: 'followup_update' as const } },
        { action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_export_context' as const, eventId: event.id, exportRowId: exported.id, role: 'current_snapshot_context' as const } },
        { action: 'create' as const, status: 'confirmed' as const, edge: { type: 'process_export_context' as const, relationId: relation.id, exportRowId: exported.id, role: 'current_snapshot_context' as const } },
        { action: 'create' as const, status: 'candidate' as const, edge: { type: 'recognized_export' as const, relationId: recognized.id, exportRowId: exported.id, role: 'candidate_same_current_row' as const } },
      ],
    }
    const plan = preflightRecordCorrespondences(db, request)
    const receipt = commitRecordCorrespondences(db, request, plan.planHash)
    expect(receipt.impact).toEqual({ created: 6, unlinked: 0, audit: 10 })
    expect(listRecordCorrespondences(db, { eventId: event.id }).map((r) => r.type)).toEqual(['event_process', 'event_recognized', 'event_export_context'])
    expect(listRecordCorrespondences(db, { relationId: recognized.id }).map((r) => r.type)).toEqual(['event_recognized', 'recognized_export'])
    expect(listRecordCorrespondences(db, { exportRowId: exported.id }).map((r) => r.type)).toEqual(['event_export_context', 'process_export_context', 'recognized_export'])
    expect(listRecordCorrespondences(db, { relationId: extra.id })).toEqual([])
    expect(listRecordCorrespondences(db, { type: 'recognized_export' })[0]?.targetIdentity).toMatchObject({ queryNaturalKey: ['recognized_list', enterprise.usccNorm, '2', recognizedQuery.queriedAt, 1], exportNaturalKey: ['specialized_sme', 2026, 'synthetic-sha', 7] })
  })

  it('confirms, rejects, unlinks and atomically corrects with revisioned audit', () => {
    const { db, event, relation, enterprise, query } = fixture()
    const other = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, rawFields: { new: 'raw' }, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    const first = save(db, request('state-create', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])).correspondenceIds[0]!
    save(db, request('state-confirm', [{ action: 'decide', correspondenceId: first, expectedRevision: 1, status: 'confirmed' }]))
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]).toMatchObject({ status: 'confirmed', revision: 2 })
    expect(() => preflightRecordCorrespondences(db, request('state-stale', [{ action: 'decide', correspondenceId: first, expectedRevision: 1, status: 'unlinked' }]))).toThrowError(CorrespondenceError)
    const corrected = save(db, request('state-correct', [{ action: 'correct', correspondenceId: first, expectedRevision: 2, edge: { type: 'event_process', eventId: event.id, relationId: other.id, role: 'context_only' } }]))
    expect(corrected.impact).toEqual({ created: 1, unlinked: 1, audit: 3 })
    expect(listRecordCorrespondences(db, { eventId: event.id }).map((r) => [r.status, r.revision])).toEqual([['unlinked', 3], ['confirmed', 2]])
    expect(getRecordCorrespondenceAudit(db, first).map((a) => [a.fromStatus, a.toStatus, a.expectedRevision, a.resultingRevision])).toEqual([[null, 'candidate', 0, 1], ['candidate', 'confirmed', 1, 2], ['confirmed', 'unlinked', 2, 3]])
    expect(getRecordCorrespondenceAudit(db, corrected.correspondenceIds[1]!).map((a) => a.toStatus)).toEqual(['candidate', 'confirmed'])
    expect(listRecordCorrespondences(db, { relationId: relation.id })[0]?.provenance).toMatchObject({ relation: { sequenceNo: 1, rawFields: { original: '原文' } } })
    const rejected = save(db, request('state-reject-create', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: other.id, role: 'supports_award' } }])).correspondenceIds[0]!
    save(db, request('state-reject', [{ action: 'decide', correspondenceId: rejected, expectedRevision: 1, status: 'rejected' }]))
    expect(getRecordCorrespondenceAudit(db, rejected).map((a) => a.toStatus)).toEqual(['candidate', 'rejected'])
  })

  it('only reproposes a rejected edge after rule or source evidence changes', () => {
    const { db, event, relation } = fixture()
    const edge = { type: 'event_process' as const, eventId: event.id, relationId: relation.id, role: 'context_only' as const }
    const id = save(db, request('rejected-original', [{ action: 'create', edge, status: 'candidate' }])).correspondenceIds[0]!
    save(db, request('rejected-decision', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'rejected' }]))
    expect(() => preflightRecordCorrespondences(db, request('rejected-same', [{ action: 'create', edge, status: 'candidate' }]))).toThrowError(CorrespondenceError)
    const changed = request('rejected-new-rule', [{ action: 'create', edge, status: 'candidate' }])
    changed.ruleVersion = '2'
    expect(save(db, changed).correspondenceIds).toEqual([id])
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]).toMatchObject({ id, status: 'candidate', revision: 3, ruleVersion: '2' })
    expect(getRecordCorrespondenceAudit(db, id).map((a) => a.toStatus)).toEqual(['candidate', 'rejected', 'candidate'])
  })

  it('rejects malformed discriminator payloads, wrong interfaces and fabricated zero-row links', () => {
    const { db, event, relation, enterprise } = fixture()
    const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'malformed-sha', importStatus: 'imported' }).returning().get()
    const exported = db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: enterprise.usccNorm }).returning().get()
    const malformed = { type: 'event_process', eventId: event.id, relationId: relation.id, exportRowId: exported.id, role: 'context_only' } as unknown as CorrespondenceEdge
    expect(() => preflightRecordCorrespondences(db, request('malformed', [{ action: 'create', status: 'candidate', edge: malformed }]))).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    expect(() => preflightRecordCorrespondences(db, request('wrong-interface', [{ action: 'create', status: 'candidate', edge: { type: 'event_recognized', eventId: event.id, relationId: relation.id, role: 'recognized_corrob' } }]))).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    const zero = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T03:00:00.000Z', status: 'no_record' }).returning().get()
    expect(() => preflightRecordCorrespondences(db, request('zero-row', [{ action: 'create', status: 'candidate', edge: { type: 'event_recognized', eventId: event.id, relationId: zero.id, role: 'recognized_corrob' } }]))).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    expect(listRecordCorrespondences(db)).toEqual([])
  })

  it('binds the preflight plan to source rows and prevents changed-key replay', () => {
    const { db, event, relation } = fixture()
    const req = request('bound', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])
    const firstPlan = preflightRecordCorrespondences(db, req)
    db.update(schema.platformRelation).set({ rawFields: { original: 'changed before commit' } }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(() => commitRecordCorrespondences(db, req, firstPlan.planHash)).toThrowError(expect.objectContaining({ code: 'plan_mismatch' }))
    expect(listRecordCorrespondences(db)).toEqual([])
    const refreshed = preflightRecordCorrespondences(db, req)
    expect(refreshed.planHash).not.toBe(firstPlan.planHash)
    const receipt = commitRecordCorrespondences(db, req, refreshed.planHash)
    expect(commitRecordCorrespondences(db, req, refreshed.planHash)).toEqual(receipt)
    expect(preflightRecordCorrespondences(db, req).batchStatus).toBe('committed')
    expect(readRecordCorrespondenceBatch(db, 'bound')).toEqual(receipt)
    expect(getRecordCorrespondenceAudit(db, receipt.correspondenceIds[0]!)).toHaveLength(1)
    const altered = { ...req, basis: 'different decision basis' }
    expect(() => preflightRecordCorrespondences(db, altered)).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => commitRecordCorrespondences(db, altered, refreshed.planHash)).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('rolls back all edges, audit and receipt when the second write fails', () => {
    const { db, event, relation, enterprise, query } = fixture()
    const second = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, matchBasis: 'uscc', verificationStatus: 'confirmed' }).returning().get()
    const req = request('atomic', [
      { action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } },
      { action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: second.id, role: 'context_only' } },
    ])
    const plan = preflightRecordCorrespondences(db, req)
    db.$client.exec(`CREATE TRIGGER reject_second_correspondence BEFORE INSERT ON record_correspondence WHEN NEW.relation_id = ${second.id} BEGIN SELECT RAISE(ABORT, 'synthetic second write failure'); END`)
    expect(() => commitRecordCorrespondences(db, req, plan.planHash)).toThrow('synthetic second write failure')
    expect(listRecordCorrespondences(db)).toEqual([])
    expect(readRecordCorrespondenceBatch(db, 'atomic')).toBeNull()
    db.$client.exec('DROP TRIGGER reject_second_correspondence')
    expect(commitRecordCorrespondences(db, req, plan.planHash).impact).toEqual(plan.impact)
  })

  it('rejects identity and title conflicts even for candidates, and keeps unknown scope unconfirmed', () => {
    const { db, event, relation, query } = fixture()
    const edge = { type: 'event_process' as const, eventId: event.id, relationId: relation.id, role: 'context_only' as const }
    db.update(schema.platformRelation).set({ usccRaw: '91330211255994458Q' }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(() => preflightRecordCorrespondences(db, request('identity-conflict', [{ action: 'create', edge, status: 'candidate' }]))).toThrowError(expect.objectContaining({ code: 'identity_conflict' }))
    db.update(schema.platformRelation).set({ usccRaw: '91330211255994457P' }).where(eq(schema.platformRelation.id, relation.id)).run()
    db.update(schema.platformQuery).set({ titleCode: 'little_giant', rdjb: '3' }).where(eq(schema.platformQuery.id, query.id)).run()
    expect(() => preflightRecordCorrespondences(db, request('title-conflict', [{ action: 'create', edge, status: 'candidate' }]))).toThrowError(expect.objectContaining({ code: 'title_conflict' }))
    db.update(schema.platformQuery).set({ titleCode: null, rdjb: '' }).where(eq(schema.platformQuery.id, query.id)).run()
    expect(() => preflightRecordCorrespondences(db, request('title-unknown-confirm', [{ action: 'create', edge, status: 'confirmed' }]))).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    expect(save(db, request('title-unknown-candidate', [{ action: 'create', edge, status: 'candidate' }])).impact.created).toBe(1)
  })

  it('does not claim an award is supported by a review process or accept missing decision attribution', () => {
    const { db, event, relation } = fixture()
    db.update(schema.platformRelation).set({ declareKind: 'review' }).where(eq(schema.platformRelation.id, relation.id)).run()
    const support = request('wrong-process-fact', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'supports_award' } }])
    expect(() => preflightRecordCorrespondences(db, support)).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    const noActor = request('missing-actor', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])
    noActor.actor.id = ''
    expect(() => preflightRecordCorrespondences(db, noActor)).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    const noBasis = request('missing-basis', noActor.operations)
    noBasis.basis = ''
    expect(() => preflightRecordCorrespondences(db, noBasis)).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
  })

  it('can retain a recognized-to-export candidate before assigning an enterprise row', () => {
    const { db, enterprise } = fixture()
    const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T04:00:00.000Z', status: 'success' }).returning().get()
    const recognized = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, usccRaw: enterprise.usccNorm, rawFields: { id: 'recognized-unassigned' }, matchBasis: 'none', verificationStatus: 'pending' }).returning().get()
    const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'unassigned-sha', importStatus: 'imported' }).returning().get()
    const exported = db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 9, usccRaw: enterprise.usccNorm }).returning().get()
    const receipt = save(db, request('unassigned-recognized', [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: recognized.id, exportRowId: exported.id, role: 'candidate_same_current_row' } }]))
    expect(listRecordCorrespondences(db, { relationId: recognized.id })[0]).toMatchObject({ id: receipt.correspondenceIds[0], status: 'candidate', enterpriseId: null, titleCode: 'specialized_sme' })
  })

  it('rejects a stale preflight after another committed decision changes its revision', () => {
    const { db, event, relation } = fixture()
    const id = save(db, request('revision-create', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])).correspondenceIds[0]!
    const stale = request('revision-stale', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }])
    const stalePlan = preflightRecordCorrespondences(db, stale)
    save(db, request('revision-winner', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'rejected' }]))
    expect(() => commitRecordCorrespondences(db, stale, stalePlan.planHash)).toThrowError(expect.objectContaining({ code: 'stale_revision', status: 409 }))
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]).toMatchObject({ status: 'rejected', revision: 2 })
    expect(readRecordCorrespondenceBatch(db, 'revision-stale')).toBeNull()
  })

  it('treats a reused key with another source identity as an idempotency conflict', () => {
    const { db, event, relation } = fixture()
    const original = request('identity-key', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])
    const plan = preflightRecordCorrespondences(db, original)
    const changed = { ...original, sourceIdentity: 'synthetic/another-source' }
    expect(() => preflightRecordCorrespondences(db, changed)).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => commitRecordCorrespondences(db, changed, plan.planHash)).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('keeps a later application separate from an earlier award and rejects an inconsistent row owner', () => {
    const { db, event, relation, enterprise } = fixture()
    db.update(schema.platformRelation).set({ declareKind: 'apply', appliedAt: '2025-01-01' }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(() => preflightRecordCorrespondences(db, request('later-cannot-support-old-award', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'supports_award' } }]))).toThrowError(expect.objectContaining({ code: 'invalid_endpoint_type' }))
    expect(save(db, request('later-is-independent', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: enterprise.id, titleCode: 'specialized_sme', predecessorEventId: event.id, relationId: relation.id, role: 'followup_apply' } }])).impact.created).toBe(1)
    expect(listRecordCorrespondences(db, { eventId: event.id })).toEqual([])
    db.update(schema.platformRelation).set({ usccRaw: '91330211255994458Q' }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(() => preflightRecordCorrespondences(db, request('row-owner-conflict', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }]))).toThrowError(expect.objectContaining({ code: 'identity_conflict' }))
  })

  it('flags confirmed correspondence for revalidation when its source row changes without erasing its old evidence', () => {
    const { db, event, relation } = fixture()
    const id = save(db, request('revalidation', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])).correspondenceIds[0]!
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.requiresRevalidation).toBe(false)
    db.update(schema.platformRelation).set({ rawFields: { original: 'corrected source' } }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]).toMatchObject({ id, status: 'confirmed', requiresRevalidation: true, provenance: { relation: { rawFields: { original: '原文' } } } })
    expect(getRecordCorrespondenceAudit(db, id)[1]?.evidence).toMatchObject({ relation: { rawFields: { original: '原文' } } })
  })

  it.each([
    ['unknown title', ({ db, query }: ReturnType<typeof fixture>) => db.update(schema.platformQuery).set({ titleCode: null, rdjb: '' }).where(eq(schema.platformQuery.id, query.id)).run(), 'context_only', 'incomplete_coverage'],
    ['pending ownership', ({ db, relation }: ReturnType<typeof fixture>) => db.update(schema.platformRelation).set({ usccRaw: null, verificationStatus: 'pending' }).where(eq(schema.platformRelation.id, relation.id)).run(), 'context_only', 'ambiguous_candidate'],
    ['incompatible process', ({ db, relation }: ReturnType<typeof fixture>) => db.update(schema.platformRelation).set({ declareKind: 'review' }).where(eq(schema.platformRelation.id, relation.id)).run(), 'supports_award', 'invalid_endpoint_type'],
    ['later application', ({ db, relation }: ReturnType<typeof fixture>) => db.update(schema.platformRelation).set({ appliedAt: '2025-01-01' }).where(eq(schema.platformRelation.id, relation.id)).run(), 'supports_award', 'invalid_endpoint_type'],
  ] as const)('rejects candidate promotion with %s', (label, arrange, role, code) => {
    const ctx = fixture()
    arrange(ctx)
    const id = save(ctx.db, request(`promotion-${label}`, [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: ctx.event.id, relationId: ctx.relation.id, role } }])).correspondenceIds[0]!
    expect(() => preflightRecordCorrespondences(ctx.db, request(`confirm-${label}`, [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }]))).toThrowError(expect.objectContaining({ code }))
    expect(listRecordCorrespondences(ctx.db, { eventId: ctx.event.id })[0]).toMatchObject({ status: 'candidate', revision: 1 })
  })

  it('rejects candidate recognized/export equivalence at promotion', () => {
    const { db, enterprise } = fixture()
    const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T04:00:00.000Z', status: 'success' }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed' }).returning().get()
    const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'promotion-sha', importStatus: 'imported' }).returning().get()
    const row = db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: enterprise.usccNorm }).returning().get()
    const id = save(db, request('recognized-candidate', [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: relation.id, exportRowId: row.id, role: 'same_current_row' } }])).correspondenceIds[0]!
    expect(() => preflightRecordCorrespondences(db, request('recognized-confirm', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }]))).toThrowError(expect.objectContaining({ code: 'incomplete_coverage' }))
    expect(listRecordCorrespondences(db, { relationId: relation.id })[0]?.status).toBe('candidate')
  })

  it('retires a drifted confirmation with a fresh revision-bound plan and retains original audit evidence', () => {
    const { db, event, relation } = fixture()
    const id = save(db, request('retire-source', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])).correspondenceIds[0]!
    db.update(schema.platformRelation).set({ usccRaw: '91330211255994458Q', rawFields: { original: 'changed' } }).where(eq(schema.platformRelation.id, relation.id)).run()
    const req = request('retire-drift', [{ action: 'decide', correspondenceId: id, expectedRevision: 2, status: 'unlinked' }])
    const plan = preflightRecordCorrespondences(db, req)
    db.update(schema.platformRelation).set({ rawFields: { original: 'changed again' } }).where(eq(schema.platformRelation.id, relation.id)).run()
    expect(() => commitRecordCorrespondences(db, req, plan.planHash)).toThrowError(expect.objectContaining({ code: 'plan_mismatch' }))
    const refreshed = preflightRecordCorrespondences(db, req)
    expect(commitRecordCorrespondences(db, req, refreshed.planHash).impact.unlinked).toBe(1)
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]).toMatchObject({ status: 'unlinked', revision: 3, provenance: { relation: { rawFields: { original: '原文' } } } })
    expect(getRecordCorrespondenceAudit(db, id)[2]?.evidence).toMatchObject({ relation: { rawFields: { original: '原文' } } })
  })

  it('atomically corrects a drifted confirmation using only valid replacement evidence', () => {
    const { db, event, relation, enterprise, query } = fixture()
    const replacement = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed' }).returning().get()
    const id = save(db, request('correct-source', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])).correspondenceIds[0]!
    db.update(schema.platformRelation).set({ usccRaw: '91330211255994458Q' }).where(eq(schema.platformRelation.id, relation.id)).run()
    const receipt = save(db, request('correct-drift', [{ action: 'correct', correspondenceId: id, expectedRevision: 2, edge: { type: 'event_process', eventId: event.id, relationId: replacement.id, role: 'context_only' } }]))
    expect(receipt.impact).toEqual({ created: 1, unlinked: 1, audit: 3 })
    expect(listRecordCorrespondences(db, { eventId: event.id }).map((row) => row.status)).toEqual(['unlinked', 'confirmed'])
    expect(getRecordCorrespondenceAudit(db, id)[2]?.evidence).toMatchObject({ relation: { usccRaw: enterprise.usccNorm } })
  })

  it('binds official evidence coordinates and stored file hash into provenance and preflight', () => {
    const { db, event, relation } = fixture()
    const file = db.insert(schema.storedFile).values({ relPath: 'jxj/announcement/synthetic.pdf', filename: 'synthetic.pdf', ext: 'pdf', bytes: 10, sha256: 'first-hash' }).returning().get()
    const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, attachment: '附件1', listNo: 7, page: 2 }).returning().get()
    const edge = { type: 'event_process' as const, eventId: event.id, relationId: relation.id, role: 'context_only' as const }
    const req = request('official-preflight', [{ action: 'create', status: 'confirmed', edge }])
    const plan = preflightRecordCorrespondences(db, req)
    db.update(schema.recordEvidence).set({ page: 3 }).where(eq(schema.recordEvidence.id, evidence.id)).run()
    expect(() => commitRecordCorrespondences(db, req, plan.planHash)).toThrowError(expect.objectContaining({ code: 'plan_mismatch' }))
    const receipt = commitRecordCorrespondences(db, req, preflightRecordCorrespondences(db, req).planHash)
    const id = receipt.correspondenceIds[0]!
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.provenance).toMatchObject({ officialEvidence: [{ evidence: { id: evidence.id, page: 3, attachment: '附件1', listNo: 7 }, storedFile: { id: file.id, sha256: 'first-hash' } }] })
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.targetIdentity).toMatchObject({ officialEvidence: [{ evidenceId: evidence.id, sourceFile: file.relPath, page: 3, storedFileId: file.id, storedFileSha256: 'first-hash' }] })
    db.update(schema.recordEvidence).set({ attachment: '附件2', listNo: 8 }).where(eq(schema.recordEvidence.id, evidence.id)).run()
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.requiresRevalidation).toBe(true)
    db.update(schema.recordEvidence).set({ attachment: '附件1', listNo: 7 }).where(eq(schema.recordEvidence.id, evidence.id)).run()
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.requiresRevalidation).toBe(false)
    db.update(schema.storedFile).set({ sha256: 'second-hash' }).where(eq(schema.storedFile.id, file.id)).run()
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.requiresRevalidation).toBe(true)
    expect(getRecordCorrespondenceAudit(db, id)[1]?.evidence).toMatchObject({ officialEvidence: [{ evidence: { page: 3 }, storedFile: { sha256: 'first-hash' } }] })
  })

  it('reconfirms the same edge after formal source correction with old and new evidence audited', () => {
    const { db, event, relation } = fixture()
    const file = db.insert(schema.storedFile).values({ relPath: 'jxj/reconfirm.pdf', filename: 'reconfirm.pdf', ext: 'pdf', bytes: 10, sha256: 'original-hash' }).returning().get()
    const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, attachment: '附件1', listNo: 7, page: 2 }).returning().get()
    const edge = { type: 'event_process' as const, eventId: event.id, relationId: relation.id, role: 'context_only' as const }
    const id = save(db, request('reconfirm-original', [{ action: 'create', status: 'confirmed', edge }])).correspondenceIds[0]!
    db.update(schema.recordEvidence).set({ page: 3 }).where(eq(schema.recordEvidence.id, evidence.id)).run()
    db.update(schema.storedFile).set({ sha256: 'corrected-hash' }).where(eq(schema.storedFile.id, file.id)).run()
    expect(listRecordCorrespondences(db, { eventId: event.id })[0]?.requiresRevalidation).toBe(true)

    const correction = request('reconfirm-corrected', [{ action: 'correct', correspondenceId: id, expectedRevision: 2, edge }])
    correction.basis = 'reviewed corrected announcement page and file hash'
    const stalePlan = preflightRecordCorrespondences(db, correction)
    expect(stalePlan.impact).toEqual({ created: 0, unlinked: 1, audit: 2 })
    db.update(schema.recordEvidence).set({ page: 4 }).where(eq(schema.recordEvidence.id, evidence.id)).run()
    expect(() => commitRecordCorrespondences(db, correction, stalePlan.planHash)).toThrowError(expect.objectContaining({ code: 'plan_mismatch' }))
    const currentPlan = preflightRecordCorrespondences(db, correction)
    const receipt = commitRecordCorrespondences(db, correction, currentPlan.planHash)
    expect(receipt.correspondenceIds).toEqual([id])
    expect(commitRecordCorrespondences(db, correction, currentPlan.planHash)).toEqual(receipt)
    expect(listRecordCorrespondences(db, { eventId: event.id })).toMatchObject([{ id, status: 'confirmed', revision: 4, requiresRevalidation: false,
      provenance: { officialEvidence: [{ evidence: { page: 4 }, storedFile: { sha256: 'corrected-hash' } }] } }])
    expect(getRecordCorrespondenceAudit(db, id)).toMatchObject([
      { toStatus: 'candidate', evidence: { officialEvidence: [{ evidence: { page: 2 }, storedFile: { sha256: 'original-hash' } }] } },
      { toStatus: 'confirmed', evidence: { officialEvidence: [{ evidence: { page: 2 }, storedFile: { sha256: 'original-hash' } }] } },
      { fromStatus: 'confirmed', toStatus: 'unlinked', expectedRevision: 2, resultingRevision: 3, evidence: { officialEvidence: [{ evidence: { page: 2 }, storedFile: { sha256: 'original-hash' } }] } },
      { fromStatus: 'unlinked', toStatus: 'confirmed', expectedRevision: 3, resultingRevision: 4, basis: correction.basis, evidence: { officialEvidence: [{ evidence: { page: 4 }, storedFile: { sha256: 'corrected-hash' } }] } },
    ])
    expect(() => preflightRecordCorrespondences(db, request('reconfirm-stale-revision', [{ action: 'correct', correspondenceId: id, expectedRevision: 2, edge }]))).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
    expect(() => preflightRecordCorrespondences(db, request('reconfirm-unchanged', [{ action: 'correct', correspondenceId: id, expectedRevision: 4, edge }]))).toThrowError(expect.objectContaining({ code: 'ambiguous_candidate' }))
    expect(() => preflightRecordCorrespondences(db, request('reconfirm-create', [{ action: 'create', status: 'confirmed', edge }]))).toThrowError(expect.objectContaining({ code: 'ambiguous_candidate' }))
  })

  it('invalidates a predecessor-only change and flags a confirmed later process', () => {
    const { db, enterprise, event, relation } = fixture()
    const edge = { type: 'later_process' as const, enterpriseId: enterprise.id, titleCode: 'specialized_sme', predecessorEventId: event.id, relationId: relation.id, role: 'followup_apply' as const }
    const req = request('predecessor-preflight', [{ action: 'create', status: 'confirmed', edge }])
    const plan = preflightRecordCorrespondences(db, req)
    db.update(schema.recordEvent).set({ batchSeq: 3 }).where(eq(schema.recordEvent.id, event.id)).run()
    expect(() => commitRecordCorrespondences(db, req, plan.planHash)).toThrowError(expect.objectContaining({ code: 'plan_mismatch' }))
    const id = commitRecordCorrespondences(db, req, preflightRecordCorrespondences(db, req).planHash).correspondenceIds[0]!
    expect(listRecordCorrespondences(db, { relationId: relation.id })[0]?.provenance).toMatchObject({ predecessor: { event: { batchSeq: 3 } } })
    db.update(schema.recordEvent).set({ batchSeq: 4 }).where(eq(schema.recordEvent.id, event.id)).run()
    expect(listRecordCorrespondences(db, { relationId: relation.id })[0]?.requiresRevalidation).toBe(true)
    expect(getRecordCorrespondenceAudit(db, id)[1]?.evidence).toMatchObject({ predecessor: { event: { batchSeq: 3 } } })
  })

  it('preserves a committed receipt when another connection commits during preflight planning', () => {
    const ctx = fixture()
    const connection = new Database(ctx.dbPath)
    connection.pragma('foreign_keys = ON')
    const second = drizzle(connection, { schema })
    const committedRequest = request('preflight-race', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: ctx.event.id, relationId: ctx.relation.id, role: 'context_only' } }])
    const original = preflightRecordCorrespondences(ctx.db, committedRequest)
    let reads = 0
    let winningReceipt: ReturnType<typeof commitRecordCorrespondences> | null = null
    const interleaved = { ...committedRequest }
    // The second connection commits after this preflight has planned but before it binds the batch.
    Object.defineProperty(interleaved, 'idempotencyKey', { enumerable: true, get() {
      reads++
      if (reads === 6) winningReceipt = commitRecordCorrespondences(second, committedRequest, original.planHash)
      return committedRequest.idempotencyKey
    } })
    try {
      expect(second.$client).not.toBe(ctx.db.$client)
      const result = preflightRecordCorrespondences(ctx.db, interleaved)
      expect(winningReceipt).not.toBeNull()
      expect(result).toMatchObject({ batchStatus: 'committed', batchId: winningReceipt!.batchId, planHash: winningReceipt!.planHash })
      expect(readRecordCorrespondenceBatch(ctx.db, committedRequest.idempotencyKey)).toEqual(winningReceipt)
      expect(commitRecordCorrespondences(ctx.db, committedRequest, original.planHash)).toEqual(winningReceipt)
    } finally {
      connection.close()
    }
  })

  it('deduplicates the same typed endpoints and role regardless of JSON property order', () => {
    const { db, event, relation } = fixture()
    save(db, request('edge-key-original', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }]))
    const reordered = { role: 'context_only', relationId: relation.id, eventId: event.id, type: 'event_process' } as CorrespondenceEdge
    expect(() => preflightRecordCorrespondences(db, request('edge-key-reordered', [{ action: 'create', status: 'candidate', edge: reordered }]))).toThrowError(expect.objectContaining({ code: 'ambiguous_candidate' }))
    expect(listRecordCorrespondences(db)).toHaveLength(1)
  })
})
