import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { listPlatformQueries } from '../../../layers/sme-roster/lib/platform/read'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { RosterImportPlatformQuery, RosterImportRelation } from '../../../layers/sme-roster/lib/roster-import-client'
import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../../../db'
import { getRecordComparison, previewRecordCorrespondenceImpact, queryProofFingerprint } from '../../../layers/sme-roster/server/utils/record-comparison'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceOperation } from '../../../layers/sme-roster/server/utils/record-correspondence'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-record-comparison-'))
  dirs.push(dir)
  const db = initializeDb({ create: true, dbPath: join(dir, 'fixture.db') })
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic official', path: 'synthetic/official.pdf' }).returning().get()
  const makeEnterprise = (name: string, uscc: string) => db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning().get()
  const makeEvent = (enterpriseId: number, type: 'award' | 'review', year: number, batchSeq: number, reviewOutcome: 'passed' | 'failed' | null = null, titleCode = 'specialized_sme') => {
    let record = db.select().from(schema.record).all().find(row => row.enterpriseId === enterpriseId && row.titleCode === titleCode && row.source === 'jxj')
    if (!record) record = db.insert(schema.record).values({ enterpriseId, titleCode, source: 'jxj' }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: type, year, batchSeq, decidedYear: type === 'review' ? year + 3 : year, reviewOutcome }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: event.id, listNo: event.id }).run()
    return event
  }
  let sourceSerial = 0
  const makeQuery = (interfaceName: 'business_list' | 'apply_list' | 'recognized_list', key: string, titleCode = 'specialized_sme', status: 'success' | 'partial' | 'failed' | 'no_record' = 'success', evidence: RosterImportPlatformQuery['collectionEvidence'] = null, relations: RosterImportRelation[] = [], sourceTime?: string) => {
    let input: RosterImportPlatformQuery
    if (!evidence && interfaceName === 'recognized_list') {
      const queriedAt = new Date(Date.UTC(2026, 9, 18, 0, 0, ++sourceSerial)).toISOString()
      const rdjb = titleCode === 'little_giant' ? '3' : '2'
      const rows = relations.map(row => ({ ...(row.rawFields ?? {}), ...(row.usccRaw == null ? {} : { tyshxydm: row.usccRaw }) }))
      const partial = status === 'partial' || status === 'failed'
      evidence = { source: 'queryBusList', status, effectiveConditions: { uscc: key, combination: 'and' }, titleScope: { mode: 'selected', rdjb: [rdjb] }, queriedAt, completedAt: queriedAt, rows: rows as never, dataRows: rows, pages: status === 'failed' ? [] : [{ source: 'queryBusList', rdjb, page: 1, status: 'success', fetchedCount: rows.length, declaredTotal: partial ? null : rows.length, error: null }], fetchedCount: rows.length, declaredTotal: partial ? null : rows.length, completeness: partial ? 'partial' : 'complete', fullRange: true, unfinished: partial ? [{ source: 'queryBusList', rdjb, page: status === 'failed' ? 1 : 2 }] : [], error: null, limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 } }
    }
    if (evidence) {
      input = platformResultToImport(evidence)
      input.relations = input.relations!.map((row, index) => ({ ...row, enterpriseId: relations[index]?.enterpriseId ?? null, matchBasis: relations[index]?.matchBasis ?? 'none', verificationStatus: relations[index]?.verificationStatus ?? 'pending' }))
    } else {
      input = { interface: interfaceName, queryKey: key, titleCode, rdjb: titleCode === 'little_giant' ? '3' : '2', queriedAt: sourceTime ?? new Date(Date.UTC(2026, 9, 18, 0, 0, ++sourceSerial)).toISOString(), status, rawResponse: 'Explicit synthetic record comparison source', relations }
    }
    const native = submitNativePlatformQuery(db, input)
    const out = listPlatformQueries(db, { queryId: native.queryId, includeRawResponse: true }).rows[0]!
    if (out.query.rawResponse === undefined || out.query.collectionEvidence === undefined) throw new Error('Fixture query omitted requested raw response')
    return { ...out.query, rawResponse: out.query.rawResponse, collectionEvidence: out.query.collectionEvidence, interface: interfaceName, status, relations: out.relations.map(row => ({ ...row, queryId: native.queryId })) }
  }
  const save = (key: string, operations: CorrespondenceOperation[]) => {
    const request = { idempotencyKey: key, sourceIdentity: `synthetic/${key}`, actor: { type: 'user' as const, id: 'synthetic-reviewer' }, basis: 'specific original row checked', ruleId: 'manual', ruleVersion: '1', operations }
    const plan = preflightRecordCorrespondences(db, request)
    return commitRecordCorrespondences(db, request, plan.planHash)
  }
  const input = (queryIds: number[], exportBatchIds: number[] = []) => ({ queryIds, exportBatchIds, officialSourceDocumentIds: [doc.id], page: 1, pageSize: 50 })
  return { db, doc, makeEnterprise, makeEvent, makeQuery, save, input, dir }
}
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

describe('record comparison public read service', () => {
  it('verified complete query coverage reaches official_without_correspondence but only for its AND subject and title', () => {
    const f = fixture(), e = f.makeEnterprise('Scoped', '91330211255994470X'), official = f.makeEvent(e.id, 'award', 2024, 1)
    const evidence = { source: 'queryBusList', status: 'no_record', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }], fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const query = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'no_record', evidence, [])
    const out = getRecordComparison(f.db, f.input([query.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: official.id }, classification: 'official_without_correspondence' })
    const other = f.makeEnterprise('Other', '91330211255994471Y'), otherEvent = f.makeEvent(other.id, 'award', 2024, 1)
    const scoped = getRecordComparison(f.db, f.input([query.id]))
    expect(scoped.rows.find(row => row.event.id === otherEvent.id)?.classification).toBe('unresolved')
  })
  it('export snapshot context does not turn complete historical absence into unresolved', () => {
    const f = fixture(), e = f.makeEnterprise('Context', '91330211255994477E'), event = f.makeEvent(e.id, 'award', 2024, 1)
    const evidence = { source: 'queryBusList', status: 'no_record', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }], fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const q = f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'no_record', evidence, [])
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'context.xlsx', sha256: 'e'.repeat(64), importStatus: 'imported' }).returning().get()
    const exportRow = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: e.usccNorm }).returning().get()
    f.save('export-context', [{ action: 'create', status: 'confirmed', edge: { type: 'event_export_context', eventId: event.id, exportRowId: exportRow.id, role: 'current_snapshot_context' } }])
    const row = getRecordComparison(f.db, f.input([q.id], [batch.id])).rows[0]!
    expect(row.classification).toBe('official_without_correspondence')
    expect(row.correspondences).toMatchObject([{ type: 'event_export_context', exportRowId: exportRow.id }])
  })
  it('trusted source-bound scope proof reaches platform_without_official and same-version field conflict', () => {
    const f = fixture(), e = f.makeEnterprise('Old name', '91330211255994472Z')
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [{ tyshxydm: e.usccNorm!, qymc: 'Old name', whpcyear: '2024' }], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const query = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'success', evidence, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '在册', declareKind: null, year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const recognized = query.relations[0]!
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'c'.repeat(64), importStatus: 'imported' }).returning().get()
    const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: e.usccNorm, nameRaw: 'New name' }).returning().get()
    const positiveProcess = f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'success', undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '认定通过', declareKind: 'apply', year: 2024, matchBasis: 'uscc', verificationStatus: 'confirmed' }])
    const positive = positiveProcess.relations[0]!
    const input = f.input([query.id, positiveProcess.id], [batch.id])
    const unproved = getRecordComparison(f.db, input)
    expect(unproved.counts.platformWithoutOfficialRows).toBe(0)
    expect(unproved.currentSourceConsistency.recognizedObservations[0]?.qualification).toBe('not_comparable')
    const proof = { officialScopes: [{ proofId: 'official-scope-1', sourceDocumentIds: [f.doc.id], titleCode: 'specialized_sme', fromYear: 2020, throughYear: 2026, enterpriseIds: [e.id], verifiedAt: '2026-10-18T01:00:00Z' }], currentScopes: [{ proofId: 'same-version-1', queryId: query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', querySourceFingerprint: queryProofFingerprint({...query,lastCollectedAt:null}), exportSha256: batch.sha256, scopeEquivalent: true as const, versionEquivalent: true as const, verifiedAt: '2026-10-18T01:00:00Z' }] }
    const out = getRecordComparison(f.db, input, proof)
    expect(out.counts.platformWithoutOfficialRows, JSON.stringify(out.platformWithoutOfficial)).toBe(1)
    expect(out.platformWithoutOfficial.rows.find(row => row.relation.id === positive.id)).toMatchObject({ relation: { id: positive.id }, qualification: 'platform_without_official', proofId: 'official-scope-1' })
    expect(out.platformWithoutOfficial.rows.find(row => row.relation.id === recognized.id)?.qualification).toBe('unresolved')
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: exported.id }], qualification: 'field_conflict', proofId: 'same-version-1' }])
    expect(out.currentSourceConsistency.exportObservations[0]?.qualification).toBe('field_conflict')
    const stale = getRecordComparison(f.db, input, { ...proof, currentScopes: [{ ...proof.currentScopes[0]!, querySourceFingerprint: 'stale' }] })
    expect(stale.currentSourceConsistency.recognizedObservations[0]?.qualification).toBe('not_comparable')
  })
  it('trusted equal-version proof distinguishes matched and export-only original rows', () => {
    const f = fixture(), e = f.makeEnterprise('Paired', '91330211255994473A')
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [{ tyshxydm: e.usccNorm!, qymc: 'Paired' }], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const q = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'success', evidence, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '在册', declareKind: null, year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const recognized = q.relations[0]!
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'same-version.xlsx', sha256: 'd'.repeat(64), importStatus: 'imported' }).returning().get()
    const matching = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: e.usccNorm, nameRaw: 'Paired' }).returning().get()
    const extra = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 2, usccRaw: '91330211255994474B', nameRaw: 'Only export' }).returning().get()
    const proof = { officialScopes: [], currentScopes: [{ proofId: 'same-version-2', queryId: q.id, exportBatchId: batch.id, titleCode: 'specialized_sme', querySourceFingerprint: queryProofFingerprint({...q,lastCollectedAt:null}), exportSha256: batch.sha256, scopeEquivalent: true as const, versionEquivalent: true as const, verifiedAt: '2026-10-18T01:00:00Z' }] }
    const out = getRecordComparison(f.db, f.input([q.id], [batch.id]), proof)
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: matching.id }], qualification: 'matched' }])
    expect(out.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: matching.id }, qualification: 'matched' }, { exportRow: { id: extra.id }, qualification: 'export_only' }])
    expect(out.currentSourceConsistency.qualification).toBe('comparable')
  })
  it('case 1 preserves aligned 2021 award and independent rejected 2025 update with current export scope unknown', () => {
    const f = fixture(), enterprise = f.makeEnterprise('A', '91330211255994457P')
    const event = f.makeEvent(enterprise.id, 'award', 2021, 1)
    const q = f.makeQuery('business_list', enterprise.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '终审通过', declareKind: 'apply', year: 2021, rawFields: undefined, matchBasis: enterprise.id ? 'uscc' : 'none', verificationStatus: enterprise.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '退回', declareKind: 'update', year: 2025, rawFields: undefined, matchBasis: enterprise.id ? 'uscc' : 'none', verificationStatus: enterprise.id ? 'confirmed' : 'pending' }])
    const award = q.relations[0]!
    const later = q.relations[1]!
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
    const q = f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), relation = q.relations[0]!
    f.save('case2', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])
    const row = getRecordComparison(f.db, f.input([q.id])).rows[0]!
    expect(row.classification).toBe('historical_conflict')
    expect(row.platformRows).toMatchObject([{ id: relation.id, status: '待审核' }])
    expect(row.reasons).toEqual(['confirmed_same_event_status_conflict'])
  })
  it('case 3 keeps failed review and later new application separate even when application is newest', () => {
    const f = fixture(), e = f.makeEnterprise('C', '91330211255994459R'), review = f.makeEvent(e.id, 'review', 2021, 1, 'failed')
    const q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), reviewed = q.relations[0]!, next = q.relations[1]!
    f.save('case3-review', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: reviewed.id, role: 'supports_review' } }])
    f.save('case3-followup', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: e.id, titleCode: 'specialized_sme', predecessorEventId: review.id, relationId: next.id, role: 'followup_apply' } }])
    const row = getRecordComparison(f.db, f.input([q.id])).rows[0]!
    expect(row.classification).toBe('historical_aligned')
    expect(row.event).toMatchObject({ year: 2021, decidedYear: 2024 })
    expect(row.platformRows[0]).toMatchObject({ id: reviewed.id, year: 2024, declareKind: 'review' })
    expect(row.event.reviewOutcome).toBe('failed')
    expect(row.laterProcesses[0]?.relation.id).toBe(next.id)
    expect(getRecordComparison(f.db, f.input([q.id])).laterProcessPlatformRows).toMatchObject([{ relation: { id: next.id }, correspondences: [{ type: 'later_process' }] }])
    expect(previewRecordCorrespondenceImpact(f.db, f.input([q.id])).proposedCandidates.some(item => item.relationId === next.id)).toBe(false)
  })
  it('independent later process remains visible without a predecessor event', () => {
    const f = fixture(), e = f.makeEnterprise('Standalone', '91330211255994479G')
    const q = f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), later = q.relations[0]!
    f.save('standalone-later', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: e.id, titleCode: 'specialized_sme', relationId: later.id, role: 'followup_apply' } }])
    const out = getRecordComparison(f.db, f.input([q.id]))
    expect(out.counts).toMatchObject({ distinctPlatformRows: 1, laterProcessRows: 1, platformWithoutOfficialRows: 0, unresolvedPlatformRows: 0 })
    expect(out.laterProcessPlatformRows).toMatchObject([{ relation: { id: later.id }, correspondences: [{ type: 'later_process' }] }])
  })
  it('review process uses decision year; original award year and unknown timing cannot decide a review', () => {
    const f = fixture(), e = f.makeEnterprise('Review', '91330211255994475C')
    const review = f.makeEvent(e.id, 'review', 2021, 1, 'passed')
    const q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'review', year: 2021, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 3, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: null, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const oldYear = q.relations[0]!
    const decided = q.relations[1]!
    const unknown = q.relations[2]!
    f.save('review-timing', [
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: oldYear.id, role: 'supports_review' } },
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: decided.id, role: 'supports_review' } },
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: unknown.id, role: 'supports_review' } },
    ])
    const row = getRecordComparison(f.db, f.input([q.id])).rows[0]!
    expect(row.classification).toBe('historical_conflict')
    expect(row.platformRows.map(item => item.id)).toEqual([oldYear.id, decided.id, unknown.id])
    f.db.update(schema.recordEvent).set({ decidedYear: null }).run()
    expect(getRecordComparison(f.db, f.input([q.id])).rows[0]).toMatchObject({ classification: 'unresolved', event: { decidedYear: null } })
  })
  it('review preview proposes the review process year, never the original award year or later application', () => {
    const f = fixture(), e = f.makeEnterprise('Preview review', '91330211255994476D'), review = f.makeEvent(e.id, 'review', 2021, 1, 'failed')
    const q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: 2021, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 3, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const originalYear = q.relations[0]!
    const decisionYear = q.relations[1]!
    const laterApply = q.relations[2]!
    expect(previewRecordCorrespondenceImpact(f.db, f.input([q.id])).proposedCandidates.map(item => item.relationId)).toEqual([decisionYear.id])
    f.db.update(schema.recordEvent).set({ decidedYear: null }).run()
    expect(previewRecordCorrespondenceImpact(f.db, f.input([q.id])).proposedCandidates).toEqual([])
    expect([originalYear.id, laterApply.id]).toHaveLength(2)
    expect(review.year).toBe(2021)
  })
  it('case 4 preserves two titles, two batches, duplicate business keys, and unlinked rows at original grain before pagination', () => {
    const f = fixture(), e = f.makeEnterprise('D', '91330211255994460S')
    const a = f.makeEvent(e.id, 'award', 2021, 1), b = f.makeEvent(e.id, 'award', 2024, 2), c = f.makeEvent(e.id, 'award', 2024, 1, null, 'little_giant')
    const q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, Array.from({ length: 6 }, (_, i) => ({ sequenceNo: i + 1, relationKey: 'DUP', enterpriseId: e.id, usccRaw: e.usccNorm, status: i === 0 ? '终审通过' : '待审核', declareKind: 'apply', year: i === 0 ? 2021 : 2024 }))), rows = q.relations
    const apply = f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), x = apply.relations[0]!, y = apply.relations[1]!
    f.save('case4', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: a.id, relationId: rows[0]!.id, role: 'supports_award' } }])
    const out = getRecordComparison(f.db, { ...f.input([q.id, apply.id]), pageSize: 1 })
    expect(out.total).toBe(3)
    expect(out.rows).toHaveLength(1)
    expect(out.counts).toMatchObject({ distinctEvents: 3, distinctPlatformRows: 8, distinctEnterpriseTitles: 2, historical_aligned: 1, unresolved: 2, unresolvedPlatformRows: 7 })
    expect([b.id, c.id, x.id, y.id]).toHaveLength(4)
  })
  it('case 5 shows two positive same-USCC same-title rows while version qualification remains unknown', () => {
    const f = fixture(), e = f.makeEnterprise('E', '91330211255994461T'), q = f.makeQuery('recognized_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '在册', declareKind: null, year: null, rawFields: { region: 'A' }, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const recognized = q.relations[0]!
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported' }).returning().get()
    const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 7, usccRaw: e.usccNorm, nameRaw: 'E', district: 'B' }).returning().get()
    const out = getRecordComparison(f.db, f.input([q.id], [batch.id]))
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: exported.id }], observation: 'same_uscc_title_observed', qualification: 'not_comparable' }])
    expect(out.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: exported.id }, recognizedRelationIds: [recognized.id] }])
    expect(out.counts).toMatchObject({ observedRecognizedExportPairs: 1, observedExportRows: 1 })
  })
  it('case 6 keeps partial/failed and full zero queries scoped, without positive rows or negative full-coverage claims', () => {
    const f = fixture(), e = f.makeEnterprise('F', '91330211255994462U'), event = f.makeEvent(e.id, 'award', 2024, 1)
    const partial = f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'partial', undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '在册', declareKind: null, year: null, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), relation = partial.relations[0]!
    const failed = f.makeQuery('recognized_list', e.usccNorm!, 'little_giant', 'failed', undefined, []), zero = f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'no_record', undefined, [])
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
    const q = f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: null, usccRaw: null, status: '终审通过', declareKind: null, year: 2024, rawFields: undefined, matchBasis: 'none', verificationStatus: 'pending' }]), candidate = q.relations[0]!
    const out = getRecordComparison(f.db, f.input([q.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: event.id, year: null }, classification: 'unresolved' })
    expect(out.rows[0]?.reasons).toContain('official_event_year_unknown')
    expect(out.counts).toMatchObject({ distinctPlatformRows: 1, unresolvedPlatformRows: 1, platformWithoutOfficialRows: 0 })
    expect(out.platformWithoutOfficial).toMatchObject({ total: 1, rows: [{ relation: { id: candidate.id, enterpriseId: null, verificationStatus: 'pending' }, qualification: 'unresolved' }] })
    expect(previewRecordCorrespondenceImpact(f.db, f.input([q.id])).dataIssues).toContainEqual(expect.objectContaining({ eventId: event.id, reasons: expect.arrayContaining(['official_event_year_unknown']) }))
    expect(candidate.enterpriseId).toBeNull()
  })
  it('pending business and apply rows remain visible at their original relation grain', () => {
    const f = fixture()
    const business = f.makeQuery('business_list', 'unidentified', undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: null, usccRaw: null, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: 'none', verificationStatus: 'pending' }]), apply = f.makeQuery('apply_list', 'unidentified', undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: null, usccRaw: 'bad-uscc', status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: 'none', verificationStatus: 'pending' }])
    const first = business.relations[0]!
    const second = apply.relations[0]!
    const out = getRecordComparison(f.db, f.input([business.id, apply.id]))
    expect(out.counts).toMatchObject({ distinctPlatformRows: 2, unresolvedPlatformRows: 2, platformWithoutOfficialRows: 0 })
    expect(out.platformWithoutOfficial.rows.map(item => item.relation.id)).toEqual([first.id, second.id])
    expect(out.platformWithoutOfficial.rows.map(item => item.reasons)).toEqual([['row_identity_unverified'], ['row_identity_unverified']])
  })
  it('asOf compares offset instants and hides decisions revised after the cutoff', () => {
    const f = fixture(), e = f.makeEnterprise('As of', '91330211255994478F'), event = f.makeEvent(e.id, 'award', 2024, 1)
    f.db.update(schema.sourceDocument).set({ issueDate: '2024-01-01' }).run()
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T01:00:00Z', completedAt: '2026-10-18T01:00:00Z', rows: [{ tyshxydm: e.usccNorm! }], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const q = f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'success', undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }], '2026-10-18T01:00:00Z')
    expect(() => getRecordComparison(f.db, { ...f.input([q.id]), asOf: '2026-10-18T08:00:00+08:00' })).toThrow('source_set_missing_or_out_of_scope')
    const atSameInstant = getRecordComparison(f.db, { ...f.input([q.id]), asOf: '2026-10-18T09:00:00+08:00' })
    expect(atSameInstant.coverage).toHaveLength(1)

    const relation = q.relations[0]!
    const receipt = f.save('asof-candidate', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'supports_award' } }])
    const edgeId = receipt.correspondenceIds[0]!
    f.db.update(schema.recordCorrespondence).set({ createdAt: '2026-10-18T00:30:00Z', status: 'rejected', revision: 2, decidedAt: '2026-10-18T02:00:00Z' }).run()
    const another = q.relations[1]!
    const confirmed = f.save('asof-confirmed', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: another.id, role: 'supports_award' } }])
    const confirmedId = confirmed.correspondenceIds[0]!
    f.db.update(schema.recordCorrespondence).set({ createdAt: '2026-10-18T00:30:00Z', status: 'unlinked', revision: 3, decidedAt: '2026-10-18T02:00:00Z', endedAt: '2026-10-18T02:00:00Z' }).where(eq(schema.recordCorrespondence.id, confirmedId)).run()
    const asOf = getRecordComparison(f.db, { ...f.input([q.id]), asOf: '2026-10-18T09:00:00+08:00' }, { officialScopes: [{ proofId: 'future-proof', sourceDocumentIds: [f.doc.id], titleCode: 'specialized_sme', fromYear: 2020, throughYear: 2026, enterpriseIds: [e.id], verifiedAt: '2026-10-18T02:00:00Z' }], currentScopes: [] })
    expect(asOf.rows[0]).toMatchObject({ classification: 'unresolved', correspondences: [] })
    expect(asOf.historicalDecisionUnavailable).toMatchObject([{ id: edgeId, eventId: event.id, relationId: relation.id, reason: 'post_cutoff_decision_state_unavailable' }, { id: confirmedId, eventId: event.id, relationId: another.id, reason: 'post_cutoff_decision_state_unavailable' }])
    expect(asOf.platformWithoutOfficial.rows).toMatchObject([{ relation: { id: relation.id }, qualification: 'unresolved' }, { relation: { id: another.id }, qualification: 'unresolved' }])
    expect(asOf.officialCoverage.proofIds).toEqual([])
    expect(JSON.stringify(asOf)).not.toContain('2026-10-18T02:00:00Z')
    expect(JSON.stringify(asOf)).not.toContain('"status":"rejected"')
    expect(JSON.stringify(asOf)).not.toContain('"status":"unlinked"')
    expect(JSON.stringify(asOf)).not.toContain('future-proof')
    expect(previewRecordCorrespondenceImpact(f.db, { ...f.input([q.id]), asOf: '2026-10-18T09:00:00+08:00' }).proposedCandidates).toEqual([])
  })
  it('equivalent asOf instants both reject a next-UTC-day export source', () => {
    const f = fixture(), e = f.makeEnterprise('Export cutoff', '91330211255994480H')
    f.db.update(schema.sourceDocument).set({ issueDate: '2024-01-01' }).run()
    const q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [])
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'future.xlsx', sha256: 'f'.repeat(64), importStatus: 'imported' }).returning().get()
    const input = f.input([q.id], [batch.id])
    expect(() => getRecordComparison(f.db, { ...input, asOf: '2026-10-19T00:30:00+08:00' })).toThrow('source_set_missing_or_out_of_scope')
    expect(() => getRecordComparison(f.db, { ...input, asOf: '2026-10-18T16:30:00Z' })).toThrow('source_set_missing_or_out_of_scope')
  })
  it('equivalent asOf instants select identical prior-UTC-day export rows and read model', () => {
    const f = fixture(), e = f.makeEnterprise('Export included', '91330211255994481J')
    f.db.update(schema.sourceDocument).set({ issueDate: '2024-01-01' }).run()
    const q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [])
    const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'included.xlsx', sha256: '1'.repeat(64), importStatus: 'imported' }).returning().get()
    const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 7, usccRaw: e.usccNorm, nameRaw: 'Export included' }).returning().get()
    const input = f.input([q.id], [batch.id])
    const offset = getRecordComparison(f.db, { ...input, asOf: '2026-10-19T00:30:00+08:00' })
    const utc = getRecordComparison(f.db, { ...input, asOf: '2026-10-18T16:30:00Z' })
    const { sourceSet: offsetSourceSet, ...offsetResult } = offset
    const { sourceSet: utcSourceSet, ...utcResult } = utc
    expect(offsetResult).toEqual(utcResult)
    expect(offsetSourceSet.exportBatchIds).toEqual(utcSourceSet.exportBatchIds)
    expect(offset.exportBatches).toMatchObject([{ id: batch.id, collectedOn: '2026-10-18' }])
    expect(offset.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: exported.id, batchId: batch.id } }])
  })
  it('legacy preview preserves originals and global counts across pages without writing', () => {
    const f = fixture(), e = f.makeEnterprise('L', '91330211255994464W'), event = f.makeEvent(e.id, 'award', 2024, 1), q = f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const relation = q.relations[0]!
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
