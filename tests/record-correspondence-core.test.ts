import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
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
  return { db, enterprise, event, query, relation }
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
function request(key: string, operations: CorrespondenceOperation[]): CorrespondenceRequest {
  return { idempotencyKey: key, sourceIdentity: 'synthetic/' + key, actor: { type: 'user', id: 'reviewer' }, basis: 'explicit source-row review', ruleId: 'manual', ruleVersion: '1', operations }
}
function save(db: ReturnType<typeof useDb>, req: CorrespondenceRequest) {
  const plan = preflightRecordCorrespondences(db, req)
  return commitRecordCorrespondences(db, req, plan.planHash)
}

describe('record correspondence core', () => {
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

  it('deduplicates the same typed endpoints and role regardless of JSON property order', () => {
    const { db, event, relation } = fixture()
    save(db, request('edge-key-original', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }]))
    const reordered = { role: 'context_only', relationId: relation.id, eventId: event.id, type: 'event_process' } as CorrespondenceEdge
    expect(() => preflightRecordCorrespondences(db, request('edge-key-reordered', [{ action: 'create', status: 'candidate', edge: reordered }]))).toThrowError(expect.objectContaining({ code: 'ambiguous_candidate' }))
    expect(listRecordCorrespondences(db)).toHaveLength(1)
  })
})
