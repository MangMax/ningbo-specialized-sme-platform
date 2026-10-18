import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { getRecordComparison, previewRecordCorrespondenceImpact, queryProofFingerprint } from '../server/utils/record-comparison'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceOperation } from '../server/utils/record-correspondence'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-record-comparison-'))
  dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'fixture.db') })
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic official', path: 'synthetic/official.pdf' }).returning().get()
  const makeEnterprise = (name: string, uscc: string) => db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning().get()
  const makeEvent = (enterpriseId: number, type: 'award' | 'review', year: number, batchSeq: number, reviewOutcome: 'passed' | 'failed' | null = null, titleCode = 'specialized_sme') => {
    let record = db.select().from(schema.record).all().find(row => row.enterpriseId === enterpriseId && row.titleCode === titleCode && row.source === 'jxj')
    if (!record) record = db.insert(schema.record).values({ enterpriseId, titleCode, source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: type, year, batchSeq, decidedYear: type === 'review' ? year + 3 : year, reviewOutcome }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: event.id, listNo: event.id }).run()
    return event
  }
  const makeQuery = (interfaceName: 'business_list' | 'apply_list' | 'recognized_list', key: string, titleCode = 'specialized_sme', status: 'success' | 'partial' | 'failed' | 'no_record' = 'success', collectionEvidence: typeof schema.platformQuery.$inferInsert.collectionEvidence = null) => db.insert(schema.platformQuery).values({ interface: interfaceName, queryKey: key, titleCode, rdjb: titleCode === 'little_giant' ? '3' : '2', queriedAt: new Date(Date.now() + Math.random() * 10000).toISOString(), status, collectionEvidence }).returning().get()
  const makeRelation = (queryId: number, enterpriseId: number | null, usccRaw: string | null, sequenceNo: number, status: string, declareKind: 'apply' | 'review' | 'update' | null, year: number | null, rawFields?: Record<string, unknown>) => db.insert(schema.platformRelation).values({ queryId, enterpriseId, usccRaw, sequenceNo, status, declareKind, year, verificationStatus: enterpriseId ? 'confirmed' : 'pending', matchBasis: enterpriseId ? 'uscc' : 'none', rawFields }).returning().get()
  const save = (key: string, operations: CorrespondenceOperation[]) => {
    const request = { idempotencyKey: key, sourceIdentity: `synthetic/${key}`, actor: { type: 'user' as const, id: 'synthetic-reviewer' }, basis: 'specific original row checked', ruleId: 'manual', ruleVersion: '1', operations }
    const plan = preflightRecordCorrespondences(db, request)
    return commitRecordCorrespondences(db, request, plan.planHash)
  }
  const input = (queryIds: number[], exportBatchIds: number[] = []) => ({ queryIds, exportBatchIds, officialSourceDocumentIds: [doc.id], page: 1, pageSize: 50 })
  return { db, doc, makeEnterprise, makeEvent, makeQuery, makeRelation, save, input, dir }
}
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

describe('record comparison public read service', () => {
  it('verified complete query coverage reaches official_without_correspondence but only for its AND subject and title', () => {
    const f = fixture(), e = f.makeEnterprise('Scoped', '91330211255994470X'), official = f.makeEvent(e.id, 'award', 2024, 1)
    const evidence = { source: 'queryBusList', status: 'no_record', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }], fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as typeof schema.platformQuery.$inferInsert.collectionEvidence
    const query = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'no_record', evidence)
    const out = getRecordComparison(f.db, f.input([query.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: official.id }, classification: 'official_without_correspondence' })
    const other = f.makeEnterprise('Other', '91330211255994471Y'), otherEvent = f.makeEvent(other.id, 'award', 2024, 1)
    const scoped = getRecordComparison(f.db, f.input([query.id]))
    expect(scoped.rows.find(row => row.event.id === otherEvent.id)?.classification).toBe('unresolved')
  })
  it('trusted source-bound scope proof reaches platform_without_official and same-version field conflict', () => {
    const f = fixture(), e = f.makeEnterprise('Old name', '91330211255994472Z')
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [{ tyshxydm: e.usccNorm!, qymc: 'Old name' }], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as typeof schema.platformQuery.$inferInsert.collectionEvidence
    const query = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'success', evidence)
    const recognized = f.makeRelation(query.id, e.id, e.usccNorm, 1, '在册', null, 2024)
    f.db.update(schema.platformRelation).set({ nameRaw: 'Old name' }).run()
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'c'.repeat(64), importStatus: 'imported' }).returning().get()
    const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: e.usccNorm, nameRaw: 'New name' }).returning().get()
    const input = f.input([query.id], [batch.id])
    const unproved = getRecordComparison(f.db, input)
    expect(unproved.counts.platformWithoutOfficialRows).toBe(0)
    expect(unproved.currentSourceConsistency.recognizedObservations[0]?.qualification).toBe('not_comparable')
    const proof = { officialScopes: [{ proofId: 'official-scope-1', sourceDocumentIds: [f.doc.id], titleCode: 'specialized_sme', fromYear: 2020, throughYear: 2026, enterpriseIds: [e.id], verifiedAt: '2026-10-18T01:00:00Z' }], currentScopes: [{ proofId: 'same-version-1', queryId: query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', querySourceFingerprint: queryProofFingerprint(query), exportSha256: batch.sha256, scopeEquivalent: true as const, versionEquivalent: true as const, verifiedAt: '2026-10-18T01:00:00Z' }] }
    const out = getRecordComparison(f.db, input, proof)
    expect(out.counts.platformWithoutOfficialRows).toBe(1)
    expect(out.platformWithoutOfficial.rows).toMatchObject([{ relation: { id: recognized.id }, qualification: 'platform_without_official', proofId: 'official-scope-1' }])
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: exported.id }], qualification: 'field_conflict', proofId: 'same-version-1' }])
    expect(out.currentSourceConsistency.exportObservations[0]?.qualification).toBe('field_conflict')
    const stale = getRecordComparison(f.db, input, { ...proof, currentScopes: [{ ...proof.currentScopes[0]!, querySourceFingerprint: 'stale' }] })
    expect(stale.currentSourceConsistency.recognizedObservations[0]?.qualification).toBe('not_comparable')
  })
  it('trusted equal-version proof distinguishes matched and export-only original rows', () => {
    const f = fixture(), e = f.makeEnterprise('Paired', '91330211255994473A')
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [{ tyshxydm: e.usccNorm!, qymc: 'Paired' }], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as typeof schema.platformQuery.$inferInsert.collectionEvidence
    const q = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'success', evidence)
    const recognized = f.makeRelation(q.id, e.id, e.usccNorm, 1, '在册', null, 2024)
    f.db.update(schema.platformRelation).set({ nameRaw: 'Paired' }).run()
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'same-version.xlsx', sha256: 'd'.repeat(64), importStatus: 'imported' }).returning().get()
    const matching = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: e.usccNorm, nameRaw: 'Paired' }).returning().get()
    const extra = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 2, usccRaw: '91330211255994474B', nameRaw: 'Only export' }).returning().get()
    const proof = { officialScopes: [], currentScopes: [{ proofId: 'same-version-2', queryId: q.id, exportBatchId: batch.id, titleCode: 'specialized_sme', querySourceFingerprint: queryProofFingerprint(q), exportSha256: batch.sha256, scopeEquivalent: true as const, versionEquivalent: true as const, verifiedAt: '2026-10-18T01:00:00Z' }] }
    const out = getRecordComparison(f.db, f.input([q.id], [batch.id]), proof)
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: matching.id }], qualification: 'matched' }])
    expect(out.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: matching.id }, qualification: 'matched' }, { exportRow: { id: extra.id }, qualification: 'export_only' }])
    expect(out.currentSourceConsistency.qualification).toBe('comparable')
  })
  it('case 1 preserves aligned 2021 award and independent rejected 2025 update with current export scope unknown', () => {
    const f = fixture(), enterprise = f.makeEnterprise('A', '91330211255994457P')
    const event = f.makeEvent(enterprise.id, 'award', 2021, 1)
    const q = f.makeQuery('business_list', enterprise.usccNorm!)
    const award = f.makeRelation(q.id, enterprise.id, enterprise.usccNorm, 1, '终审通过', 'apply', 2021)
    const later = f.makeRelation(q.id, enterprise.id, enterprise.usccNorm, 2, '退回', 'update', 2025)
    f.save('case1-award', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: award.id, role: 'supports_award' } }])
    f.save('case1-later', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: enterprise.id, titleCode: 'specialized_sme', predecessorEventId: event.id, relationId: later.id, role: 'followup_update' } }])
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2025, collectedOn: '2025-10-18', originalFilename: 'synthetic.xlsx', sha256: 'a'.repeat(64), importStatus: 'imported' }).returning().get()
    const out = getRecordComparison(f.db, f.input([q.id], [batch.id]))
    expect(out.rows[0]).toMatchObject({ classification: 'historical_aligned', event: { id: event.id }, laterProcesses: [{ relation: { id: later.id, status: '退回' } }] })
    expect(out.counts).toMatchObject({ historical_aligned: 1, laterProcessRows: 1, laterProcessAffectedEvents: 1 })
    expect(out.currentSourceConsistency.qualification).toBe('not_comparable')
  })
  it('case 2 gives confirmed same-event conflict precedence without inferring why recognized row is absent', () => {
    const f = fixture(), e = f.makeEnterprise('B', '91330211255994458Q'), event = f.makeEvent(e.id, 'award', 2024, 2)
    const q = f.makeQuery('apply_list', e.usccNorm!), relation = f.makeRelation(q.id, e.id, e.usccNorm, 1, '待审核', 'apply', 2024)
    f.save('case2', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])
    const row = getRecordComparison(f.db, f.input([q.id])).rows[0]!
    expect(row.classification).toBe('historical_conflict')
    expect(row.platformRows).toMatchObject([{ id: relation.id, status: '待审核' }])
    expect(row.reasons).toEqual(['confirmed_same_event_status_conflict'])
  })
  it('case 3 keeps failed review and later new application separate even when application is newest', () => {
    const f = fixture(), e = f.makeEnterprise('C', '91330211255994459R'), review = f.makeEvent(e.id, 'review', 2021, 1, 'failed')
    const q = f.makeQuery('business_list', e.usccNorm!), reviewed = f.makeRelation(q.id, e.id, e.usccNorm, 1, '未通过', 'review', 2021), next = f.makeRelation(q.id, e.id, e.usccNorm, 2, '待审核', 'apply', 2025)
    f.save('case3-review', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: reviewed.id, role: 'supports_review' } }])
    f.save('case3-followup', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: e.id, titleCode: 'specialized_sme', predecessorEventId: review.id, relationId: next.id, role: 'followup_apply' } }])
    const row = getRecordComparison(f.db, f.input([q.id])).rows[0]!
    expect(row.classification).toBe('historical_aligned')
    expect(row.event.reviewOutcome).toBe('failed')
    expect(row.laterProcesses[0]?.relation.id).toBe(next.id)
  })
  it('case 4 preserves two titles, two batches, duplicate business keys, and unlinked rows at original grain before pagination', () => {
    const f = fixture(), e = f.makeEnterprise('D', '91330211255994460S')
    const a = f.makeEvent(e.id, 'award', 2021, 1), b = f.makeEvent(e.id, 'award', 2024, 2), c = f.makeEvent(e.id, 'award', 2024, 1, null, 'little_giant')
    const q = f.makeQuery('business_list', e.usccNorm!), rows = Array.from({ length: 6 }, (_, i) => f.makeRelation(q.id, e.id, e.usccNorm, i + 1, i === 0 ? '终审通过' : '待审核', 'apply', i === 0 ? 2021 : 2024))
    f.db.update(schema.platformRelation).set({ relationKey: 'DUP' }).run()
    const apply = f.makeQuery('apply_list', e.usccNorm!), x = f.makeRelation(apply.id, e.id, e.usccNorm, 1, '待审核', 'apply', 2025), y = f.makeRelation(apply.id, e.id, e.usccNorm, 2, '待审核', 'apply', 2025)
    f.save('case4', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: a.id, relationId: rows[0]!.id, role: 'supports_award' } }])
    const out = getRecordComparison(f.db, { ...f.input([q.id, apply.id]), pageSize: 1 })
    expect(out.total).toBe(3)
    expect(out.rows).toHaveLength(1)
    expect(out.counts).toMatchObject({ distinctEvents: 3, distinctPlatformRows: 8, distinctEnterpriseTitles: 2, historical_aligned: 1, unresolved: 2, unresolvedPlatformRows: 7 })
    expect([b.id, c.id, x.id, y.id]).toHaveLength(4)
  })
  it('case 5 shows two positive same-USCC same-title rows while version qualification remains unknown', () => {
    const f = fixture(), e = f.makeEnterprise('E', '91330211255994461T'), q = f.makeQuery('recognized_list', e.usccNorm!)
    const recognized = f.makeRelation(q.id, e.id, e.usccNorm, 1, '在册', null, null, { region: 'A' })
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported' }).returning().get()
    const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 7, usccRaw: e.usccNorm, nameRaw: 'E', district: 'B' }).returning().get()
    const out = getRecordComparison(f.db, f.input([q.id], [batch.id]))
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: exported.id }], observation: 'same_uscc_title_observed', qualification: 'not_comparable' }])
    expect(out.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: exported.id }, recognizedRelationIds: [recognized.id] }])
    expect(out.counts).toMatchObject({ observedRecognizedExportPairs: 1, observedExportRows: 1 })
  })
  it('case 6 keeps partial/failed and full zero queries scoped, without positive rows or negative full-coverage claims', () => {
    const f = fixture(), e = f.makeEnterprise('F', '91330211255994462U'), event = f.makeEvent(e.id, 'award', 2024, 1)
    const partial = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'partial'), relation = f.makeRelation(partial.id, e.id, e.usccNorm, 1, '在册', null, null)
    const failed = f.makeQuery('recognized_list', e.usccNorm!, 'little_giant', 'failed'), zero = f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'no_record')
    const out = getRecordComparison(f.db, f.input([partial.id, failed.id, zero.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: event.id }, classification: 'unresolved' })
    expect(out.counts).toMatchObject({ distinctPlatformRows: 1, official_without_correspondence: 0 })
    expect(out.coverage.find(item => item.queryId === partial.id)?.reasons).toContain('incomplete_or_continuation')
    expect(out.coverage.find(item => item.queryId === failed.id)?.reasons).toContain('query_failed')
    expect(out.coverage.find(item => item.queryId === zero.id)?.titleCoverage[0]?.complete).toBe(false)
    expect(out.currentSourceConsistency.recognizedObservations[0]?.recognized.id).toBe(relation.id)
  })
  it('case 7 leaves missing event year and unverified identity unresolved without guessing from names', () => {
    const f = fixture(), e = f.makeEnterprise('Same Name', '91330211255994463V'), event = f.makeEvent(e.id, 'award', 2024, 1)
    f.db.update(schema.recordEvent).set({ year: null }).run()
    const q = f.makeQuery('apply_list', e.usccNorm!), candidate = f.makeRelation(q.id, null, null, 1, '终审通过', null, 2024)
    const out = getRecordComparison(f.db, f.input([q.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: event.id, year: null }, classification: 'unresolved' })
    expect(out.rows[0]?.reasons).toContain('official_event_year_unknown')
    expect(out.platformWithoutOfficial.rows).toEqual([])
    expect(previewRecordCorrespondenceImpact(f.db, f.input([q.id])).dataIssues).toContainEqual(expect.objectContaining({ eventId: event.id, reasons: expect.arrayContaining(['official_event_year_unknown']) }))
    expect(candidate.enterpriseId).toBeNull()
  })
  it('legacy preview preserves originals and global counts across pages without writing', () => {
    const f = fixture(), e = f.makeEnterprise('L', '91330211255994464W'), event = f.makeEvent(e.id, 'award', 2024, 1), q = f.makeQuery('business_list', e.usccNorm!)
    const relation = f.makeRelation(q.id, e.id, e.usccNorm, 1, '终审通过', 'apply', 2024)
    const old = f.db.insert(schema.differenceReason).values({ enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'manual_review', recordedAt: '2025-01-01T00:00:00Z' }).returning().get()
    f.db.insert(schema.differenceReason).values({ enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2025-02-01T00:00:00Z' }).run()
    const before = f.db.select().from(schema.differenceReason).all()
    const out = previewRecordCorrespondenceImpact(f.db, { ...f.input([q.id]), page: 2, pageSize: 1 })
    expect(out.total).toBe(2)
    expect(out.counts.legacyRows).toBe(2)
    expect(out.rows[0]?.disposition).toBe('legacy_pending_review')
    expect(out.rows[0]?.possibleEventIds).toEqual([event.id])
    expect(out.proposedCandidates).toMatchObject([{ eventId: event.id, relationId: relation.id, status: 'candidate', qualification: 'requires_explicit_review' }])
    expect(out.counts.proposedCandidateEdges).toBe(1)
    expect(out.modelIssues).toContain('official_source_completeness_not_persisted')
    expect(f.db.select().from(schema.differenceReason).all()).toEqual(before)
    expect(old.status).toBe('confirmed_reason')
  })
})
