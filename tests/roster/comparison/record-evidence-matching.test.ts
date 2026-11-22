import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { readPostgresPlatformQueries } from '../../../layers/sme-roster/lib/platform/postgres-query-read'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { RosterImportPlatformQuery, RosterImportRelation } from '../../../layers/sme-roster/lib/roster-import-client'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { readPostgresRecordComparison } from '../../../layers/sme-roster/server/utils/record-comparison-postgres'
import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import type { CorrespondenceOperation } from '../../../layers/sme-roster/server/utils/record-correspondence-model'
import * as schema from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { sourceDocument } from '../../../db/postgresql/official-evidence-tables'
import { platformExportBatch, platformExportRow } from '../../../db/postgresql/platform-tables'

const openDatabase = useIsolatedPostgresCases()

async function fixture() {
  const db = openDatabase()
  const doc = singlePostgresFixtureRow(await db.insert(sourceDocument).values({ source: 'jxj', title: 'Synthetic official', path: 'synthetic/official.pdf' }).returning())
  const makeEnterprise = async (name: string, uscc: string) => singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: uscc }).returning())
  const makeEvent = async (enterpriseId: number, type: 'award' | 'review', year: number, batchSeq: number, reviewOutcome: 'passed' | 'failed' | null = null, titleCode = 'specialized_sme') => {
    let record = (await db.select().from(schema.record)).find(row => row.enterpriseId === enterpriseId && row.titleCode === titleCode && row.source === 'jxj')
    if (!record) record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId, titleCode, source: 'jxj' }).returning())
    const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: type, year, batchSeq, decidedYear: type === 'review' ? year + 3 : year, reviewOutcome }).returning())
    await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: event.id, listNo: event.id })
    return event
  }
  let sourceSerial = 0
  const makeQuery = async (interfaceName: 'business_list' | 'apply_list' | 'recognized_list', key: string, titleCode = 'specialized_sme', status: 'success' | 'partial' | 'failed' | 'no_record' = 'success', evidence: RosterImportPlatformQuery['collectionEvidence'] = null, relations: RosterImportRelation[] = [], sourceTime?: string) => {
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
    const native = await seedPostgresPlatformQuery(db, input)
    const out = (await readPostgresPlatformQueries(db, { queryId: native.queryId })).rows[0]!
    return { ...out.query, interface: interfaceName, status, relations: out.relations.map(row => ({ ...row, queryId: native.queryId })) }
  }
  const save = async (key: string, operations: CorrespondenceOperation[]) => {
    const request = { idempotencyKey: key, sourceIdentity: `synthetic/${key}`, actor: { type: 'user' as const, id: 'synthetic-reviewer' }, basis: 'specific original row checked', ruleId: 'manual', ruleVersion: '1', operations }
    const plan = await preflightPostgresCorrespondences(db, request)
    return await commitPostgresCorrespondences(db, request, plan.planHash)
  }
  const input = (queryIds: number[], exportBatchIds: number[] = []) => ({ queryIds, exportBatchIds, officialSourceDocumentIds: [doc.id], page: 1, pageSize: 50 })
  return { db, doc, makeEnterprise, makeEvent, makeQuery, save, input }
}

describe('record comparison public read service', () => {
  it('verified complete query coverage reaches official_without_correspondence but only for its AND subject and title', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Scoped', '91330211255994470X'), official = await f.makeEvent(e.id, 'award', 2024, 1)
    const evidence = { source: 'queryBusList', status: 'no_record', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }], fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const query = await f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'no_record', evidence, [])
    const out = await readPostgresRecordComparison(f.db, f.input([query.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: official.id }, classification: 'official_without_correspondence' })
    const other = await f.makeEnterprise('Other', '91330211255994471Y'), otherEvent = await f.makeEvent(other.id, 'award', 2024, 1)
    const scoped = await readPostgresRecordComparison(f.db, f.input([query.id]))
    expect(scoped.rows.find(row => row.event.id === otherEvent.id)?.classification).toBe('unresolved')
    const failed = await f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'failed')
    const retry = await readPostgresRecordComparison(f.db, f.input([query.id, failed.id]))
    expect(retry.rows).toMatchObject([
      { event: { id: official.id }, classification: 'official_without_correspondence' },
      { event: { id: otherEvent.id }, classification: 'unresolved' },
    ])
    expect(retry.coverage).toMatchObject([
      { queryId: query.id, status: 'no_record', titleCoverage: [{ complete: true }] },
      { queryId: failed.id, status: 'failed', titleCoverage: [{ complete: false }] },
    ])
  })
  it('preserves capture metadata without drawing official-event conclusions from rollback rows', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Cross-scope', '91330211255994470X')
    const official = await f.makeEvent(e.id, 'award', 2024, 1)
    const unrelated = await f.makeEvent(e.id, 'award', 2024, 1, null, 'innovative_sme')
    const original = await f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'success', null, [{
      sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, matchBasis: 'uscc', verificationStatus: 'confirmed',
      rawFields: { id: 'cross-scope-record', rdjb: '2' },
    }])
    const before = await readPostgresRecordComparison(f.db, f.input([original.id]))
    expect(before.rows).toMatchObject([
      { event: { id: official.id }, classification: 'official_without_correspondence' },
      { event: { id: unrelated.id }, classification: 'unresolved' },
    ])
    const current = await f.makeQuery('recognized_list', e.usccNorm!, 'little_giant', 'success', null, [{
      sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, matchBasis: 'uscc', verificationStatus: 'confirmed',
      rawFields: { id: 'cross-scope-record', rdjb: '3' },
    }])
    const after = await readPostgresRecordComparison(f.db, f.input([original.id, current.id]))
    expect(after.rows).toMatchObject([
      { event: { id: official.id }, classification: 'unresolved' },
      { event: { id: unrelated.id }, classification: 'unresolved' },
    ])
    expect(after.platformWithoutOfficial.rows.map(row => row.relation.id)).toEqual([current.relations[0]!.id])
    expect(after.coverage).toMatchObject([
      { queryId: original.id, status: 'success', titleCoverage: [{ rdjb: '2', complete: false, pageCount: 1 }] },
      { queryId: current.id, status: 'success', titleCoverage: [{ rdjb: '3', complete: true, pageCount: 1 }] },
    ])
  })
  it('export snapshot context does not turn complete historical absence into unresolved', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Context', '91330211255994477E'), event = await f.makeEvent(e.id, 'award', 2024, 1)
    const evidence = { source: 'queryBusList', status: 'no_record', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:01Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }], fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const q = await f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'no_record', evidence, [])
    const batch = singlePostgresFixtureRow(await f.db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'context.xlsx', sha256: 'e'.repeat(64), importStatus: 'imported', createdAt: '2026-10-18T00:00:00Z' }).returning())
    const exportRow = singlePostgresFixtureRow(await f.db.insert(platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, createdAt: '2026-10-18T00:00:00Z', usccRaw: e.usccNorm }).returning())
    await f.save('export-context', [{ action: 'create', status: 'confirmed', edge: { type: 'event_export_context', eventId: event.id, exportRowId: exportRow.id, role: 'current_snapshot_context' } }])
    const row = (await readPostgresRecordComparison(f.db, f.input([q.id], [batch.id]))).rows[0]!
    expect(row.classification).toBe('official_without_correspondence')
    expect(row.correspondences).toMatchObject([{ type: 'event_export_context', exportRowId: exportRow.id }])
  })
  it('case 1 preserves aligned 2021 award and independent rejected 2025 update with current export scope unknown', async () => {
    const f = await fixture(), enterprise = await f.makeEnterprise('A', '91330211255994457P')
    const event = await f.makeEvent(enterprise.id, 'award', 2021, 1)
    const q = await f.makeQuery('business_list', enterprise.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '终审通过', declareKind: 'apply', year: 2021, rawFields: undefined, matchBasis: enterprise.id ? 'uscc' : 'none', verificationStatus: enterprise.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '退回', declareKind: 'update', year: 2025, rawFields: undefined, matchBasis: enterprise.id ? 'uscc' : 'none', verificationStatus: enterprise.id ? 'confirmed' : 'pending' }])
    const award = q.relations[0]!
    const later = q.relations[1]!
    await f.save('case1-award', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: award.id, role: 'supports_award' } }])
    await f.save('case1-later', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: enterprise.id, titleCode: 'specialized_sme', predecessorEventId: event.id, relationId: later.id, role: 'followup_update' } }])
    const batch = singlePostgresFixtureRow(await f.db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2025, collectedOn: '2025-10-18', originalFilename: 'synthetic.xlsx', sha256: 'a'.repeat(64), importStatus: 'imported', createdAt: '2026-10-18T00:00:00Z' }).returning())
    const out = await readPostgresRecordComparison(f.db, f.input([q.id], [batch.id]))
    expect(out.rows[0]).toMatchObject({ classification: 'historical_aligned', event: { id: event.id }, laterProcesses: [{ relation: { id: later.id, status: '退回' } }] })
    expect(out.counts).toMatchObject({ historical_aligned: 1, laterProcessRows: 1, laterProcessAffectedEvents: 1 })
    expect(out.currentSourceConsistency.qualification).toBe('not_comparable')
  })
  it('case 2 gives confirmed same-event conflict precedence without inferring why recognized row is absent', async () => {
    const f = await fixture(), e = await f.makeEnterprise('B', '91330211255994458Q'), event = await f.makeEvent(e.id, 'award', 2024, 2)
    const q = await f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), relation = q.relations[0]!
    await f.save('case2', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }])
    const row = (await readPostgresRecordComparison(f.db, f.input([q.id]))).rows[0]!
    expect(row.classification).toBe('historical_conflict')
    expect(row.platformRows).toMatchObject([{ id: relation.id, status: '待审核' }])
    expect(row.reasons).toEqual(['confirmed_same_event_status_conflict'])
  })
  it('case 3 keeps failed review and later new application separate even when application is newest', async () => {
    const f = await fixture(), e = await f.makeEnterprise('C', '91330211255994459R'), review = await f.makeEvent(e.id, 'review', 2021, 1, 'failed')
    const q = await f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), reviewed = q.relations[0]!, next = q.relations[1]!
    await f.save('case3-review', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: reviewed.id, role: 'supports_review' } }])
    await f.save('case3-followup', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: e.id, titleCode: 'specialized_sme', predecessorEventId: review.id, relationId: next.id, role: 'followup_apply' } }])
    const row = (await readPostgresRecordComparison(f.db, f.input([q.id]))).rows[0]!
    expect(row.classification).toBe('historical_aligned')
    expect(row.event).toMatchObject({ year: 2021, decidedYear: 2024 })
    expect(row.platformRows[0]).toMatchObject({ id: reviewed.id, year: 2024, declareKind: 'review' })
    expect(row.event.reviewOutcome).toBe('failed')
    expect(row.laterProcesses[0]?.relation.id).toBe(next.id)
    expect((await readPostgresRecordComparison(f.db, f.input([q.id]))).laterProcessPlatformRows).toMatchObject([{ relation: { id: next.id }, correspondences: [{ type: 'later_process' }] }])
  })
  it('independent later process remains visible without a predecessor event', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Standalone', '91330211255994479G')
    const q = await f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), later = q.relations[0]!
    await f.save('standalone-later', [{ action: 'create', status: 'confirmed', edge: { type: 'later_process', enterpriseId: e.id, titleCode: 'specialized_sme', relationId: later.id, role: 'followup_apply' } }])
    const out = await readPostgresRecordComparison(f.db, f.input([q.id]))
    expect(out.counts).toMatchObject({ distinctPlatformRows: 1, laterProcessRows: 1, platformWithoutOfficialRows: 0, unresolvedPlatformRows: 0 })
    expect(out.laterProcessPlatformRows).toMatchObject([{ relation: { id: later.id }, correspondences: [{ type: 'later_process' }] }])
  })
  it('review process uses decision year; original award year and unknown timing cannot decide a review', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Review', '91330211255994475C')
    const review = await f.makeEvent(e.id, 'review', 2021, 1, 'passed')
    const q = await f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'review', year: 2021, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 3, enterpriseId: e.id, usccRaw: e.usccNorm, status: '未通过', declareKind: 'review', year: null, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const oldYear = q.relations[0]!
    const decided = q.relations[1]!
    const unknown = q.relations[2]!
    await f.save('review-timing', [
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: oldYear.id, role: 'supports_review' } },
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: decided.id, role: 'supports_review' } },
      { action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: review.id, relationId: unknown.id, role: 'supports_review' } },
    ])
    const row = (await readPostgresRecordComparison(f.db, f.input([q.id]))).rows[0]!
    expect(row.classification).toBe('historical_conflict')
    expect(row.platformRows.map(item => item.id)).toEqual([oldYear.id, decided.id, unknown.id])
    await f.db.update(schema.recordEvent).set({ decidedYear: null })
    expect((await readPostgresRecordComparison(f.db, f.input([q.id]))).rows[0]).toMatchObject({ classification: 'unresolved', event: { decidedYear: null } })
  })
  it('preserves official batches and every verified row across pages and titles in the current capture', async () => {
    const f = await fixture(), e = await f.makeEnterprise('D', '91330211255994460S')
    const a = await f.makeEvent(e.id, 'award', 2021, 1), b = await f.makeEvent(e.id, 'award', 2024, 2), c = await f.makeEvent(e.id, 'award', 2024, 1, null, 'little_giant')
    const queriedAt = '2026-10-18T00:00:00Z'
    const dataRows = Array.from({ length: 6 }, (_, i) => ({
      id: 'DUP', rdjb: i < 4 ? '2' : '3', tyshxydm: e.usccNorm!, qymc: e.name,
      cszt: i === 0 ? '终审通过' : '待审核', sblx: 'apply', year: i === 0 ? '2021' : '2024',
    }))
    const q = await f.makeQuery('business_list', e.usccNorm!, undefined, 'success', {
      source: 'businessList', status: 'success', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' },
      titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] }, queriedAt, completedAt: queriedAt,
      rows: dataRows, dataRows, pages: [
        { source: 'businessList', rdjb: '1', page: 1, maxPage: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null },
        { source: 'businessList', rdjb: '2', page: 1, maxPage: 2, status: 'success', fetchedCount: 2, declaredTotal: 4, error: null },
        { source: 'businessList', rdjb: '2', page: 2, maxPage: 2, status: 'success', fetchedCount: 2, declaredTotal: 4, error: null },
        { source: 'businessList', rdjb: '3', page: 1, maxPage: 1, status: 'success', fetchedCount: 2, declaredTotal: 2, error: null },
      ], fetchedCount: 6, declaredTotal: 6, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { pageSize: 2, maxRequests: 4, maxRows: 6, maxDurationMs: 1000 },
    }, dataRows.map((_, i) => ({ sequenceNo: i + 1, enterpriseId: e.id, matchBasis: 'uscc', verificationStatus: 'confirmed' })))
    const rows = q.relations
    const apply = await f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [1, 2].map(sequenceNo => ({
      sequenceNo, enterpriseId: e.id, usccRaw: e.usccNorm, status: '待审核', declareKind: 'apply', year: 2025,
      matchBasis: 'uscc', verificationStatus: 'confirmed',
    })))
    await f.save('case4', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: a.id, relationId: rows[0]!.id, role: 'supports_award' } }])
    const out = await readPostgresRecordComparison(f.db, { ...f.input([q.id, apply.id]), pageSize: 1 })
    expect(out.total).toBe(3)
    expect(out.rows).toMatchObject([{ event: { id: a.id }, platformRows: [{ id: rows[0]!.id, status: '终审通过', sourceRdjb: '2', sourcePage: 1 }] }])
    expect(out.counts).toMatchObject({ distinctEvents: 3, distinctPlatformRows: 8, distinctEnterpriseTitles: 2, historical_aligned: 1, official_without_correspondence: 2, unresolvedPlatformRows: 7 })
    expect(out.platformWithoutOfficial.rows.map(row => row.relation.id)).toEqual([...rows.slice(1), ...apply.relations].map(row => row.id))
    expect(out.platformWithoutOfficial.rows.slice(0, 5).map(({ relation }) => [relation.sourceRdjb, relation.sourcePage])).toEqual([
      ['2', 1], ['2', 2], ['2', 2], ['3', 1], ['3', 1],
    ])
    const unpaged = await readPostgresRecordComparison(f.db, f.input([q.id, apply.id]))
    expect(unpaged.rows).toMatchObject([
      { event: { id: a.id }, classification: 'historical_aligned' },
      { event: { id: b.id }, classification: 'official_without_correspondence' },
      { event: { id: c.id }, classification: 'official_without_correspondence' },
    ])
  })
  it('case 5 shows two positive same-USCC same-title rows while version qualification remains unknown', async () => {
    const f = await fixture(), e = await f.makeEnterprise('E', '91330211255994461T'), q = await f.makeQuery('recognized_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '在册', declareKind: null, year: null, rawFields: { region: 'A' }, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }])
    const recognized = q.relations[0]!
    const batch = singlePostgresFixtureRow(await f.db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported', createdAt: '2026-10-18T00:00:00Z' }).returning())
    const exported = singlePostgresFixtureRow(await f.db.insert(platformExportRow).values({ batchId: batch.id, sourceRowNo: 7, createdAt: '2026-10-18T00:00:00Z', usccRaw: e.usccNorm, nameRaw: 'E', district: 'B' }).returning())
    const out = await readPostgresRecordComparison(f.db, f.input([q.id], [batch.id]))
    expect(out.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: recognized.id }, exportRows: [{ id: exported.id }], observation: 'same_uscc_title_observed', qualification: 'not_comparable' }])
    expect(out.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: exported.id }, recognizedRelationIds: [recognized.id] }])
    expect(out.counts).toMatchObject({ observedRecognizedExportPairs: 1, observedExportRows: 1 })
  })
  it('case 6 keeps partial/failed and full zero queries scoped, without positive rows or negative full-coverage claims', async () => {
    const f = await fixture(), e = await f.makeEnterprise('F', '91330211255994462U'), event = await f.makeEvent(e.id, 'award', 2024, 1)
    const partial = await f.makeQuery('recognized_list', e.usccNorm!, 'specialized_sme', 'partial', undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '在册', declareKind: null, year: null, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }]), relation = partial.relations[0]!
    const failed = await f.makeQuery('recognized_list', e.usccNorm!, 'little_giant', 'failed', undefined, []), zero = await f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'no_record', undefined, [])
    const out = await readPostgresRecordComparison(f.db, f.input([partial.id, failed.id, zero.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: event.id }, classification: 'unresolved' })
    expect(out.counts).toMatchObject({ distinctPlatformRows: 1, official_without_correspondence: 0 })
    expect(out.coverage.find(item => item.queryId === partial.id)?.reasons).toContain('incomplete_or_continuation')
    expect(out.coverage.find(item => item.queryId === failed.id)?.reasons).toContain('query_failed')
    expect(out.coverage.find(item => item.queryId === zero.id)?.titleCoverage[0]?.complete).toBe(false)
    expect(out.currentSourceConsistency.recognizedObservations[0]?.recognized.id).toBe(relation.id)
  })
  it('case 7 leaves missing event year and unverified identity unresolved without guessing from names', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Same Name', '91330211255994463V'), event = await f.makeEvent(e.id, 'award', 2024, 1)
    await f.db.update(schema.recordEvent).set({ year: null })
    const q = await f.makeQuery('apply_list', e.usccNorm!, undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: null, usccRaw: null, status: '终审通过', declareKind: null, year: 2024, rawFields: undefined, matchBasis: 'none', verificationStatus: 'pending' }]), candidate = q.relations[0]!
    const out = await readPostgresRecordComparison(f.db, f.input([q.id]))
    expect(out.rows[0]).toMatchObject({ event: { id: event.id, year: null }, classification: 'unresolved' })
    expect(out.rows[0]?.reasons).toContain('official_event_year_unknown')
    expect(out.counts).toMatchObject({ distinctPlatformRows: 1, unresolvedPlatformRows: 1, platformWithoutOfficialRows: 0 })
    expect(out.platformWithoutOfficial).toMatchObject({ total: 1, rows: [{ relation: { id: candidate.id, enterpriseId: null, verificationStatus: 'pending' }, qualification: 'unresolved' }] })
    expect(candidate.enterpriseId).toBeNull()
  })
  it('pending business and apply rows remain visible at their original relation grain', async () => {
    const f = await fixture()
    const business = await f.makeQuery('business_list', 'unidentified', undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: null, usccRaw: null, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: 'none', verificationStatus: 'pending' }]), apply = await f.makeQuery('apply_list', 'unidentified', undefined, undefined, undefined, [{ sequenceNo: 1, enterpriseId: null, usccRaw: 'bad-uscc', status: '待审核', declareKind: 'apply', year: 2025, rawFields: undefined, matchBasis: 'none', verificationStatus: 'pending' }])
    const first = business.relations[0]!
    const second = apply.relations[0]!
    const out = await readPostgresRecordComparison(f.db, f.input([business.id, apply.id]))
    expect(out.counts).toMatchObject({ distinctPlatformRows: 2, unresolvedPlatformRows: 2, platformWithoutOfficialRows: 0 })
    expect(out.platformWithoutOfficial.rows.map(item => item.relation.id)).toEqual([first.id, second.id])
    expect(out.platformWithoutOfficial.rows.map(item => item.reasons)).toEqual([['row_identity_unverified'], ['row_identity_unverified']])
  })
  it('asOf compares offset instants and hides decisions revised after the cutoff', async () => {
    const f = await fixture(), e = await f.makeEnterprise('As of', '91330211255994478F'), event = await f.makeEvent(e.id, 'award', 2024, 1)
    await f.db.update(sourceDocument).set({ issueDate: '2024-01-01' })
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T01:00:00Z', completedAt: '2026-10-18T01:00:00Z', rows: [{ tyshxydm: e.usccNorm! }], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as RosterImportPlatformQuery['collectionEvidence']
    const q = await f.makeQuery('business_list', e.usccNorm!, 'specialized_sme', 'success', undefined, [{ sequenceNo: 1, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }, { sequenceNo: 2, enterpriseId: e.id, usccRaw: e.usccNorm, status: '终审通过', declareKind: 'apply', year: 2024, rawFields: undefined, matchBasis: e.id ? 'uscc' : 'none', verificationStatus: e.id ? 'confirmed' : 'pending' }], '2026-10-18T01:00:00Z')
    await expect(readPostgresRecordComparison(f.db, { ...f.input([q.id]), asOf: '2026-10-18T08:00:00+08:00' })).rejects.toThrow('source_set_missing_or_out_of_scope')
    const atSameInstant = await readPostgresRecordComparison(f.db, { ...f.input([q.id]), asOf: '2026-10-18T09:00:00+08:00' })
    expect(atSameInstant.coverage).toHaveLength(1)

    const relation = q.relations[0]!
    const receipt = await f.save('asof-candidate', [{ action: 'create', status: 'candidate', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'supports_award' } }])
    const edgeId = receipt.correspondenceIds[0]!
    await f.db.update(schema.recordCorrespondence).set({ createdAt: '2026-10-18T00:30:00Z', status: 'rejected', revision: 2, decidedAt: '2026-10-18T02:00:00Z' })
    const another = q.relations[1]!
    const confirmed = await f.save('asof-confirmed', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: another.id, role: 'supports_award' } }])
    const confirmedId = confirmed.correspondenceIds[0]!
    await f.db.update(schema.recordCorrespondence).set({ createdAt: '2026-10-18T00:30:00Z', status: 'unlinked', revision: 3, decidedAt: '2026-10-18T02:00:00Z', endedAt: '2026-10-18T02:00:00Z' }).where(eq(schema.recordCorrespondence.id, confirmedId))
    const asOf = await readPostgresRecordComparison(f.db, { ...f.input([q.id]), asOf: '2026-10-18T09:00:00+08:00' })
    expect(asOf.rows[0]).toMatchObject({ classification: 'unresolved', correspondences: [] })
    expect(asOf.historicalDecisionUnavailable).toMatchObject([{ id: edgeId, eventId: event.id, relationId: relation.id, reason: 'post_cutoff_decision_state_unavailable' }, { id: confirmedId, eventId: event.id, relationId: another.id, reason: 'post_cutoff_decision_state_unavailable' }])
    expect(asOf.platformWithoutOfficial.rows).toMatchObject([{ relation: { id: relation.id }, qualification: 'unresolved' }, { relation: { id: another.id }, qualification: 'unresolved' }])
    expect(asOf.officialCoverage).toMatchObject({ qualification: 'unknown' })
    expect(JSON.stringify(asOf)).not.toContain('2026-10-18T02:00:00Z')
    expect(JSON.stringify(asOf)).not.toContain('"status":"rejected"')
    expect(JSON.stringify(asOf)).not.toContain('"status":"unlinked"')
  })
  it('equivalent asOf instants both reject a next-UTC-day export source', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Export cutoff', '91330211255994480H')
    await f.db.update(sourceDocument).set({ issueDate: '2024-01-01' })
    const q = await f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [])
    const batch = singlePostgresFixtureRow(await f.db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'future.xlsx', sha256: 'f'.repeat(64), importStatus: 'imported', createdAt: '2026-10-18T00:00:00Z' }).returning())
    const input = f.input([q.id], [batch.id])
    await expect(readPostgresRecordComparison(f.db, { ...input, asOf: '2026-10-19T00:30:00+08:00' })).rejects.toThrow('source_set_missing_or_out_of_scope')
    await expect(readPostgresRecordComparison(f.db, { ...input, asOf: '2026-10-18T16:30:00Z' })).rejects.toThrow('source_set_missing_or_out_of_scope')
  })
  it('equivalent asOf instants select identical prior-UTC-day export rows and read model', async () => {
    const f = await fixture(), e = await f.makeEnterprise('Export included', '91330211255994481J')
    await f.db.update(sourceDocument).set({ issueDate: '2024-01-01' })
    const q = await f.makeQuery('business_list', e.usccNorm!, undefined, undefined, undefined, [])
    const batch = singlePostgresFixtureRow(await f.db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'included.xlsx', sha256: '1'.repeat(64), importStatus: 'imported', createdAt: '2026-10-18T00:00:00Z' }).returning())
    const exported = singlePostgresFixtureRow(await f.db.insert(platformExportRow).values({ batchId: batch.id, sourceRowNo: 7, createdAt: '2026-10-18T00:00:00Z', usccRaw: e.usccNorm, nameRaw: 'Export included' }).returning())
    const input = f.input([q.id], [batch.id])
    const offset = await readPostgresRecordComparison(f.db, { ...input, asOf: '2026-10-19T00:30:00+08:00' })
    const utc = await readPostgresRecordComparison(f.db, { ...input, asOf: '2026-10-18T16:30:00Z' })
    const { sourceSet: offsetSourceSet, ...offsetResult } = offset
    const { sourceSet: utcSourceSet, ...utcResult } = utc
    expect(offsetResult).toEqual(utcResult)
    expect(offsetSourceSet.exportBatchIds).toEqual(utcSourceSet.exportBatchIds)
    expect(offset.exportBatches).toMatchObject([{ id: batch.id, collectedOn: '2026-10-18' }])
    expect(offset.currentSourceConsistency.exportObservations).toMatchObject([{ exportRow: { id: exported.id, batchId: batch.id } }])
  })
})
