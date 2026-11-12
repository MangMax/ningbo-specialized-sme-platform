import { transferDifferenceReferences } from '../upgrade/difference-references'
import Database from 'better-sqlite3'
import { createServer } from 'node:http'
import { createApp, toNodeListener, defineEventHandler, getQuery, setHeader, createError } from 'h3'
import { targetSchema } from '../lib/platform/target-schema'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi, describe } from 'vitest'
import { eq } from 'drizzle-orm'
import { readRecordComparison, readRecordComparisonSources } from '../server/utils/record-comparison-read'
import { preflightComparisonScopeProofs, commitComparisonScopeProofs, readComparisonScopeProof, resolveVerifiedComparisonEvidence, type ProofRequest } from '../server/utils/comparison-scope-proof'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { assertExpandRuntime } from '../db/schema-phase'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import * as schema from '../db/schema'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { inspectLegacyPlatformProvenance, writeLegacyPlatformProvenance } from '../server/utils/platform-legacy-provenance'
import type { LegacyPlatformProvenanceInput } from '../lib/platform/legacy-provenance'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { getRecordComparison, listRecordComparisonSources, previewRecordCorrespondenceImpact } from '../server/utils/record-comparison'
import { commitRecordCorrespondences, preflightRecordCorrespondences, type CorrespondenceRequest } from '../server/utils/record-correspondence'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
vi.mock('../db', async importOriginal => ({ ...await importOriginal<typeof import('../db')>(), useDb: () => db }))

let fixture: Awaited<ReturnType<typeof witnessReaderFixture>>
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
const trace: string[] = []
let proofId: number
let officialProofId: number
const input = { queryIds: [401, 402, 403, 404], exportBatchIds: [701], officialSourceDocumentIds: [1], page: 1, pageSize: 50 }
function manual(database: typeof db, key: string, operations: CorrespondenceRequest['operations'], proofIds?: number[]) {
  const request: CorrespondenceRequest = { idempotencyKey: key, sourceIdentity: 'synthetic748/' + key, actor: { type: 'user', id: 'reviewer' }, basis: 'original normal source checked', ruleId: 'manual', ruleVersion: '1', operations, proofIds }
  return commitRecordCorrespondences(database, request, preflightRecordCorrespondences(database, request).planHash)
}
describe.each([71611,71612])('completed target %i', phase => {
beforeAll(async () => {
  fixture = await witnessReaderFixture(source => {
    const old = drizzle(source, { schema })
    old.insert(schema.enterprise).values({ id: 10, name: 'Comparison', nameNorm: 'Comparison', usccNorm: 'U10' }).run()
    old.insert(schema.record).values({ id: 10, enterpriseId: 10, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U10' }).run()
    old.insert(schema.sourceDocument).values({ id: 1, source: 'jxj', path: 'synthetic/official.pdf', issueDate: '2026-01-01', title: 'Official' }).run()
    old.insert(schema.storedFile).values({ id: 2, relPath: 'synthetic/official.pdf', filename: 'official.pdf', ext: 'pdf', bytes: 10, sha256: 'a'.repeat(64), source: 'jxj', kind: 'announcement' }).run()
    old.insert(schema.recordEvent).values([10, 11, 12, 13, 14].map(id => ({ id, recordId: 10, eventType: 'award' as const, year: 2024 }))).run()
    old.insert(schema.recordEvidence).values([10, 11, 12, 13, 14].map(id => ({ recordEventId: id, sourceFile: 'synthetic/official.pdf', page: id, listNo: id }))).run()
    for (const [id, kind] of [[401, 'business_list'], [402, 'apply_list'], [403, 'recognized_list'], [404, 'business_list']] as const) {
      old.insert(schema.platformQuery).values({ id, interface: kind, queryKey: 'U10', rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-0${id - 400}T00:00:00Z`, status: 'success' }).run()
      old.insert(schema.platformRelation).values({ id, queryId: id, sequenceNo: 1, relationKey: kind === 'business_list' ? 'SAME' : kind, enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Comparison', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: kind === 'business_list' ? 'SAME' : kind, rdjb: '2', sblx: '申请', year: 2024, cszt: '终审通过' } }).run()
      ensurePlatformObservation(old, id)
    }
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-10T00:00:00Z')
    for (const [id, status] of [[10, 'confirmed'], [11, 'candidate'], [12, 'rejected'], [13, 'confirmed']] as const) {
      const saved = manual(old, 'old-' + id, [{ action: 'create', status, edge: { type: 'event_process', eventId: id, relationId: 401, role: 'supports_award' } }])
      if (id === 13) { vi.setSystemTime('2026-10-20T00:00:00Z'); manual(old, 'unlink', [{ action: 'decide', correspondenceId: saved.correspondenceIds[0]!, expectedRevision: 2, status: 'unlinked' }]); vi.setSystemTime('2026-10-10T00:00:00Z') }
    }
    old.insert(schema.enterprise).values({ id: 20, name: 'Review', nameNorm: 'Review', usccNorm: 'U20' }).run()
    old.insert(schema.record).values({ id: 20, enterpriseId: 20, titleCode: 'specialized_sme', source: 'jxj', usccRaw: 'U20' }).run()
    for (const [id, eventType, year, decidedYear, reviewOutcome] of [[20, 'award', 2024, 2024, null], [21, 'review', 2021, 2024, 'passed'], [22, 'review', 2021, 2024, 'failed'], [23, 'review', 2021, null, 'passed'], [24, 'award', 2024, 2024, null], [25, 'award', 2024, 2024, null]] as const) {
      old.insert(schema.recordEvent).values({ id, recordId: 20, eventType, year, decidedYear, reviewOutcome }).run()
      old.insert(schema.recordEvidence).values({ recordEventId: id, sourceFile: 'synthetic/official.pdf', listNo: id }).run()
      const rawFields = { id: 'R' + id, rdjb: '2', sblx: eventType === 'review' ? '复核' : '申请', year: 2024, cszt: [20, 22].includes(id) ? '退回' : '终审通过' }
      old.insert(schema.platformQuery).values({ id: id + 600, interface: 'business_list', queryKey: 'U20', rdjb: '2', queriedAt: `2026-10-0${id - 19}T00:00:00Z`, status: 'success' }).run()
      old.insert(schema.platformRelation).values({ id: id + 600, queryId: id + 600, sequenceNo: 1, relationKey: rawFields.id, enterpriseId: 20, nameRaw: 'Review', usccRaw: 'U20', matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields }).run()
      ensurePlatformObservation(old, id + 600)
      manual(old, 'review-' + id, [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: id, relationId: id + 600, role: id === 24 ? 'context_only' : eventType === 'review' ? 'supports_review' : 'supports_award' } }])
      if (id === 25) old.update(schema.platformRelation).set({ status: '退回' }).where(eq(schema.platformRelation.id, 625)).run() // Ordinary legacy source correction after confirmation.
    }
    vi.useRealTimers()
    const evidence: PlatformLiveQueryResult = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T00:01:00Z', rows: [{ id: 'recognized_list', rdjb: '2' }],
      pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, declaredTotal: 1, fetchedCount: 1, status: 'success', error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 10, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } }
    old.update(schema.platformQuery).set({ collectionEvidence: evidence }).where(eq(schema.platformQuery.id, 403)).run()
    for (const [id, status] of [[501, 'failed'], [502, 'partial'], [503, 'no_record'], [504, 'not_queried']] as const) {
      const empty: PlatformLiveQueryResult = { ...evidence, status, rows: [], pages: status === 'not_queried' ? [] : [{ ...evidence.pages[0]!, status: status === 'failed' ? 'failed' : 'success', fetchedCount: 0, declaredTotal: 0 }], fetchedCount: 0, declaredTotal: 0,
        completeness: status === 'no_record' ? 'complete' : status === 'not_queried' ? 'not_queried' : 'partial', fullRange: status === 'no_record', unfinished: status === 'no_record' ? [] : [{ source: 'queryBusList', rdjb: '2', page: status === 'partial' ? 2 : 1 }] }
      old.insert(schema.platformQuery).values({ id, interface: 'recognized_list', queryKey: 'empty' + id, rdjb: '2', queriedAt: evidence.queriedAt, status, collectionEvidence: empty }).run()
    }
    const mixed: PlatformLiveQueryResult = { ...evidence, titleScope: { mode: 'selected', rdjb: ['3', '2'] }, rows: [{ id: 'M1', rdjb: '2' }, { id: 'M2' }], fetchedCount: 2, declaredTotal: 2,
      pages: ['3', '2'].map(rdjb => ({ ...evidence.pages[0]!, rdjb })) }
    old.insert(schema.platformQuery).values({ id: 505, interface: 'recognized_list', queryKey: 'mixed', rdjb: '3,2', queriedAt: evidence.queriedAt, status: 'success', collectionEvidence: mixed }).run()
    old.insert(schema.platformRelation).values(mixed.rows.map((rawFields, i) => ({ id: 505 + i, queryId: 505, sequenceNo: i + 1, relationKey: rawFields.id, enterpriseId: 10, nameRaw: 'Former', usccRaw: 'U10', matchBasis: 'uscc' as const, verificationStatus: 'confirmed' as const, rawFields }))).run()
    ensurePlatformObservation(old, 505); ensurePlatformObservation(old, 506)
    const legacyRaw = { id: 'LEGACY748', rdjb: '2', year: '2024', sblx: '申请', cszt: '终审通过' }
    old.insert(schema.platformQuery).values({ id: 507, interface: 'business_list', queryKey: '91330211255994457P', rdjb: '2', queriedAt: evidence.queriedAt, status: 'success' }).run()
    old.insert(schema.platformRelation).values({ id: 507, queryId: 507, sequenceNo: 1, relationKey: 'LEGACY748', enterpriseId: 10, nameRaw: 'Comparison', usccRaw: 'U10', matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields: legacyRaw }).run()
    ensurePlatformObservation(old, 507)
    const supplemental: LegacyPlatformProvenanceInput = { queryId: 507, interface: 'business_list', queryKey: '91330211255994457P', rdjb: '2', queriedAt: evidence.queriedAt, sourceIdentity: 'synthetic748/legacy', sourceSha256: '9'.repeat(64), segmentIndex: 0,
      collection: { ...evidence, source: 'businessList', effectiveConditions: { uscc: '91330211255994457P', combination: 'and' }, rows: [legacyRaw], pages: [{ ...evidence.pages[0]!, source: 'businessList' }] }, relations: [{ sequenceNo: 1, relationKey: 'LEGACY748', rawFields: legacyRaw }] }
    const batch = old.insert(schema.importBatch).values({ idempotencyKey: 'legacy748', sourceKind: 'platform_archive', sourceIdentity: 'synthetic748/legacy', status: 'committed' }).returning().get()
    writeLegacyPlatformProvenance(old, supplemental, batch.id, inspectLegacyPlatformProvenance(old, supplemental).inputFingerprint)
    old.insert(schema.enterpriseAlias).values({ enterpriseId: 10, name: 'Former', nameNorm: 'Former', sourceKind: 'manual', verificationStatus: 'confirmed', note: '归并自 enterprise:99' }).run()
    old.insert(schema.platformExportBatch).values({ id: 701, titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-03', originalFilename: 'synthetic.xlsx', sha256: '7'.repeat(64), importStatus: 'imported', rowCount: 1 }).run()
    old.insert(schema.platformExportRow).values({ id: 701, batchId: 701, sourceRowNo: 1, usccRaw: 'U10', nameRaw: 'Comparison' }).run()
    old.insert(schema.storedFile).values({ id: 1, relPath: 'synthetic/freeze.json', filename: 'freeze.json', ext: 'json', bytes: 10, sha256: '8'.repeat(64), source: 'miit', kind: 'export' }).run()
    const proof: ProofRequest = { idempotencyKey: 'old-proof', sourceIdentity: 'synthetic748/freeze', actor: { type: 'user', id: 'reviewer' }, basis: 'normal same account frozen export comparison', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: { queryId: 403, exportBatchId: 701, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256', scope: { queryAccount: 'same', exportAccount: 'same', queryRegion: 'Ningbo', exportRegion: 'Ningbo', queryFilters: { combination: 'and' }, exportFilters: { combination: 'and' }, windowStart: '2026-10-03T00:00:00Z', windowEnd: '2026-10-03T23:59:59Z', platformVersion: 'synthetic', freezeReference: 'synthetic/freeze.json', freezeFileId: 1, freezeSha256: '8'.repeat(64) } } }] }
    proofId = commitComparisonScopeProofs(old, proof, preflightComparisonScopeProofs(old, proof).planHash).proofIds[0]!
    manual(old, 'export-context748', [
      { action: 'create', status: 'confirmed', edge: { type: 'event_export_context', eventId: 14, exportRowId: 701, role: 'current_snapshot_context' } },
      { action: 'create', status: 'confirmed', edge: { type: 'process_export_context', relationId: 404, exportRowId: 701, role: 'current_snapshot_context' } },
      { action: 'create', status: 'confirmed', edge: { type: 'recognized_export', relationId: 403, exportRowId: 701, role: 'same_current_row' } },
    ], [proofId])
    const official: ProofRequest = { ...proof, idempotencyKey: 'official-proof748', sourceIdentity: 'synthetic748/official', operations: [{ action: 'create', kind: 'official_coverage', status: 'confirmed', evidence: { titleCode: 'specialized_sme', fromYear: 2024, throughYear: 2024, enterpriseIds: [10], fullRange: true, sourceDocuments: [{ id: 1, fileId: 2, sha256: 'a'.repeat(64), reference: { field: 'record_evidence.source_file', page: 10, listNo: 10 } }] } }] }
    officialProofId = commitComparisonScopeProofs(old, official, preflightComparisonScopeProofs(old, official).planHash).proofIds[0]!
    old.insert(schema.differenceReason).values({ enterpriseId: 10, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'not_queried', recordedAt: '2026-10-01' }).run()
  })
  fixture.close()
  const source = join(fixture.root, 'process-source.sqlite')
  copyFileSync(fixture.target, source)
  finalizeProcessStored({ source, target: fixture.target, runId: 'process', predecessorRunId: 'witness', legacySource: fixture.legacySource })
  const previous = join(fixture.root, 'comparison-71610.sqlite')
  copyFileSync(fixture.target, previous)
  transferCorrespondence({ source: previous, target: fixture.target, runId: 'comparison748' })
  if (phase === 71612) {
    const fixed = join(fixture.root,'difference-fixed-71611.sqlite'); copyFileSync(fixture.target,fixed)
    transferDifferenceReferences({source:fixed,target:fixture.target,runId:'difference749'})
  }
  // Reopen the unchanged old normal service as the independent baseline.
  const legacy = new Database(fixture.legacySource, { readonly: true })
  fixture.old = legacy
})
let caseNumber = 0
beforeEach(() => {
  const file = join(fixture.root, `comparison-case-${++caseNumber}.sqlite`)
  copyFileSync(fixture.target, file)
  sqlite = new Database(file, { verbose: q => trace.push(String(q)) })
  sqlite.pragma('foreign_keys=ON')
  sqlite.pragma('journal_mode=WAL')
  db = drizzle(sqlite, { schema })
  trace.length = 0
})
afterEach(() => { sqlite?.close() })
afterAll(() => { fixture?.old.close() })
it('preserves complete comparison classifications observations catalog and preview through offline 71611', () => {
  const old = drizzle(fixture.old, { schema })
  const expected = getRecordComparison(old, input)
  expect(expected.rows.filter(row => row.event.id < 20).map(row => [row.event.id, row.classification])).toEqual([[10, 'historical_aligned'], [11, 'unresolved'], [12, 'official_without_correspondence'], [13, 'official_without_correspondence'], [14, 'official_without_correspondence']])
  trace.length = 0
  expect(getRecordComparison(db, input)).toEqual(expected)
  expect(listRecordComparisonSources(db, { page: 1, pageSize: 50 })).toEqual(listRecordComparisonSources(old, { page: 1, pageSize: 50 }))
  expect(previewRecordCorrespondenceImpact(db, input)).toEqual(previewRecordCorrespondenceImpact(old, input))
  expect(trace.some(q => /\b(?:from|join)\s+"?platform_(?:query|relation)"?(?:\s|$)/i.test(q))).toBe(false)
})
it('preserves requested page and row title distinctions plus failed partial empty and not-queried coverage', () => {
  const old = drizzle(fixture.old, { schema })
  const selection = { ...input, queryIds: [501, 502, 503, 504, 505], exportBatchIds: [] }
  const expected = getRecordComparison(old, selection)
  expect(expected.coverage.map(q => [q.queryId, q.completeness, q.titleCoverage.map(t => [t.rdjb, t.complete])])).toEqual([
    [501, 'partial', [['2', false]]], [502, 'partial', [['2', false]]], [503, 'complete', [['2', true]]], [504, 'not_queried', [['2', false]]], [505, 'complete', [['3', true], ['2', true]]],
  ])
  expect(expected.currentSourceConsistency.recognizedObservations.map(r => [r.recognized.id, r.recognized.titleCode, r.recognized.sourceRdjb])).toEqual([[505, 'little_giant', '3'], [506, 'specialized_sme', '2']])
  expect(getRecordComparison(db, selection)).toEqual(expected)
  for (const queryIds of [[501], [502], [503], [504]]) expect(getRecordComparison(db, { ...selection, queryIds })).toEqual(getRecordComparison(old, { ...selection, queryIds }))
})
it('keeps global catalog counts cross-kind pages explicit filters and original enterprise links', () => {
  const old = drizzle(fixture.old, { schema })
  for (const filter of [{ page: 1, pageSize: 2 }, { page: 5, pageSize: 2 }, { page: 6, pageSize: 3 }, { kind: 'query' as const, page: 2, pageSize: 3 }, { kind: 'query' as const, ids: [1, 403, 505, 701], page: 1, pageSize: 2 }, { kind: 'query' as const, ids: [], page: 1, pageSize: 2 }]) {
    expect(listRecordComparisonSources(db, filter)).toEqual(listRecordComparisonSources(old, filter))
  }
  const catalog = listRecordComparisonSources(db, { kind: 'query', ids: [505], page: 1, pageSize: 1 })
  expect(catalog).toMatchObject({ counts: { official_document: 0, query: 1, export_batch: 0 }, rows: [{ id: 505, confirmedEnterprises: [{ relationId: 505, enterpriseName: 'Comparison', nameRaw: 'Former', aliasConfirmed: true, mergedFromEnterpriseId: 99 }, { relationId: 506 }] }] })
})
it('rejects duplicate missing and post-asOf selections and preserves date-only source boundaries', () => {
  for (const database of [db, drizzle(fixture.old, { schema })]) {
    for (const key of ['queryIds', 'exportBatchIds', 'officialSourceDocumentIds'] as const) {
      expect(() => getRecordComparison(database, { ...input, [key]: [input[key][0]!, input[key][0]!] })).toThrow('duplicate_' + key)
      expect(() => getRecordComparison(database, { ...input, [key]: [9999] })).toThrow('source_set_missing_or_out_of_scope')
    }
    expect(() => getRecordComparison(database, { ...input, asOf: '2026-10-03T23:59:59Z' })).toThrow('source_set_missing_or_out_of_scope')
    expect(() => getRecordComparison(database, { ...input, queryIds: [403], asOf: '2026-10-03T00:00:00Z' })).not.toThrow()
  }
  const selection = { ...input, asOf: '2026-10-04T00:00:00Z' }
  expect(getRecordComparison(db, selection)).toEqual(getRecordComparison(drizzle(fixture.old, { schema }), selection))
  expect(getRecordComparison(db, selection).historicalDecisionUnavailable).toEqual([]) // Edges created after cutoff were not yet present.
})
it('preserves original confirmed proof digests and independent business observations through the public read service', async () => {
  const old = drizzle(fixture.old, { schema })
  expect(readComparisonScopeProof(db, proofId)).toEqual(readComparisonScopeProof(old, proofId))
  expect(readComparisonScopeProof(db, proofId)).toMatchObject({ valid: true, status: 'confirmed', revision: 2 })
  const selected = { ...input, proofIds: [proofId] }
  const expected = getRecordComparison(old, selected, resolveVerifiedComparisonEvidence(old, [proofId], selected))
  expect(expected.currentSourceConsistency.recognizedObservations).toMatchObject([{ recognized: { id: 403 }, qualification: 'matched' }])
  expect(expected.businessCounts).toMatchObject({ observations: 4 })
  expect(await readRecordComparison(db, selected)).toEqual(expected)
  expect(await readRecordComparisonSources(db, { page: 5, pageSize: 2 })).toEqual(listRecordComparisonSources(old, { page: 5, pageSize: 2 }))
})
it('preserves historical candidate confirmed rejected unlinked states and post-cutoff revisions', () => {
  const old = drizzle(fixture.old, { schema })
  const current = getRecordComparison(db, input)
  expect(current.rows.slice(0, 4).map(row => row.correspondences[0]?.status)).toEqual(['confirmed', 'candidate', 'rejected', 'unlinked'])
  const selection = { ...input, asOf: '2026-10-15T00:00:00Z' }
  expect(getRecordComparison(db, selection)).toEqual(getRecordComparison(old, selection))
  expect(getRecordComparison(db, selection).historicalDecisionUnavailable).toMatchObject([{ eventId: 13, relationId: 401, reason: 'post_cutoff_decision_state_unavailable' }])
  expect(getRecordComparison(db, selection).rows.find(r => r.event.id === 13)).toMatchObject({ classification: 'unresolved' })
  const grouped = current.businessGroups.rows.find(g => g.versions.some(v => v.observations.some(r => r.relation.id === 401)))
  expect(grouped).toMatchObject({ versions: [{ observations: [{ relation: { id: 401 } }, { relation: { id: 404 } }] }] })
})
it('cancels cooperative reads releases snapshots and leaves business state unchanged', async () => {
  const before = sqlite.prepare('select total_changes() n').get()
  const controller = new AbortController()
  const reading = readRecordComparison(db, input, controller.signal)
  const rejection = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(sqlite.prepare('select total_changes() n').get()).toEqual(before)
  expect(await readRecordComparison(db, input)).toEqual(getRecordComparison(db, input))
  expect(sqlite.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }])
  expect(() => assertExpandRuntime(sqlite)).toThrow('Finalized/offline target schema cannot be opened')
})
it('scopes stored observation FKs before exposing nonidentity aliases and sees normal next-request source and decision updates', async () => {
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  const add = (date: string, status = '终审通过') => {
    const rawFields = { id: 'NEW748', rdjb: '2', sblx: '申请', year: 2024, cszt: status }
    return writeNewCollectionTarget(db, { queryText: JSON.stringify({ interface: 'business_list', queryKey: 'U10', rdjb: '2', titleCode: 'specialized_sme', queriedAt: date, status: 'success', rawResponse: 'normal synthetic original', relations: [{ sequenceNo: 1, relationKey: 'NEW748', enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Comparison', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields }] }), evidenceText: null, createdAt: date,
      assignments: [{ enterpriseId: 10, usccRaw: 'U10', nameRaw: 'Comparison', verificationStatus: 'confirmed', matchBasis: 'uscc', origin: 'command', actor: { type: 'user', id: 'reviewer' }, basis: 'normal confirmed identity', recordedAt: date }] })
  }
  const a = add('2026-11-01T00:00:00Z'), b = add('2026-11-02T00:00:00Z')
  expect(a.queryAlias).not.toBe(a.collectionId)
  expect(a.observations[0]!.relationAlias).not.toBe(a.observations[0]!.observationId)
  expect(b.observations[0]!.versionId).toBe(a.observations[0]!.versionId)
  const selection = { ...input, queryIds: [a.queryAlias, b.queryAlias], exportBatchIds: [], enterpriseId: 10 }
  const before = await readRecordComparison(db, selection)
  expect(before.rows.find(r => r.event.id === 14)).toMatchObject({ classification: 'unresolved', correspondences: [] })
  const saved = manual(db, 'new-confirm748', [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: 14, relationId: b.observations[0]!.relationAlias, role: 'supports_award' } }])
  trace.length = 0
  const next = getRecordComparison(db, selection)
  expect(next.rows.find(r => r.event.id === 14)).toMatchObject({ classification: 'historical_aligned', correspondences: [{ relationId: b.observations[0]!.relationAlias, requiresRevalidation: false }] })
  expect(getRecordComparison(db, input).rows.find(r => r.event.id === 14)?.correspondences.filter(r => r.relationId !== null)).toEqual([])
  expect(trace.some(q => /\b(?:from|join)\s+"?platform_(?:query|relation)"?(?:\s|$)/i.test(q))).toBe(false)
  manual(db, 'new-unlink748', [{ action: 'decide', correspondenceId: saved.correspondenceIds[0]!, expectedRevision: 2, status: 'unlinked' }])
  expect((await readRecordComparison(db, selection)).rows.find(r => r.event.id === 14)).toMatchObject({ classification: 'unresolved', correspondences: [{ status: 'unlinked', revision: 3 }] })
  const c = add('2026-11-03T00:00:00Z', '退回')
  const fresh = await readRecordComparison(db, { ...selection, queryIds: [...selection.queryIds, c.queryAlias] })
  expect(fresh.businessCounts).toMatchObject({ observations: 3, versions: 2 })
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})
it('observes normal confirmed proof revocation on the next public request', async () => {
  const selected = { ...input, proofIds: [proofId] }
  expect((await readRecordComparison(db, selected)).currentSourceConsistency.recognizedObservations[0]?.qualification).toBe('matched')
  const request: ProofRequest = { idempotencyKey: 'revoke748', sourceIdentity: 'synthetic748/freeze', actor: { type: 'user', id: 'reviewer' }, basis: 'normal withdrawal of equivalence', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'decide', proofId, expectedRevision: 2, status: 'revoked' }] }
  commitComparisonScopeProofs(db, request, preflightComparisonScopeProofs(db, request).planHash)
  expect((await readRecordComparison(db, selected)).currentSourceConsistency.recognizedObservations[0]?.qualification).toBe('not_comparable')
  expect(readComparisonScopeProof(db, proofId)).toMatchObject({ status: 'revoked', revision: 3 })
})
it('retains review business-year role and source field conflicts with global counts and independent event business pages', () => {
  const selected = { ...input, queryIds: [620, 621, 622, 623, 624, 625], exportBatchIds: [], enterpriseId: 20 }
  const old = drizzle(fixture.old, { schema })
  const expected = getRecordComparison(old, selected)
  expect(expected.rows.map(r => [r.event.id, r.classification])).toEqual([[20, 'historical_conflict'], [21, 'historical_aligned'], [22, 'historical_aligned'], [23, 'unresolved'], [24, 'unresolved'], [25, 'unresolved']])
  expect(expected.rows.find(r => r.event.id === 25)?.reasons).toEqual(['platform_field_conflict'])
  expect(getRecordComparison(db, selected)).toEqual(expected)
  const page = { ...selected, page: 2, pageSize: 1, businessPage: 3, businessPageSize: 1 }
  expect(getRecordComparison(db, page)).toEqual(getRecordComparison(old, page))
  expect(getRecordComparison(db, page)).toMatchObject({ total: 6, rows: [{ event: { id: 21 } }], businessGroups: { total: 6, page: 3, rows: [{ firstRelationId: 622 }] }, counts: { historical_aligned: 2, historical_conflict: 1 } })
  expect(previewRecordCorrespondenceImpact(db, selected)).toEqual(previewRecordCorrespondenceImpact(old, selected))
})
it('reads the complete migrated comparison and catalog through actual REST and MCP handlers', async () => {
  for (const [name, value] of Object.entries({ defineEventHandler, getQuery, setHeader, createError })) vi.stubGlobal(name, value)
  const rest = (await import('../server/api/roster/record-comparison.get')).default
  const catalog = (await import('../server/api/roster/record-comparison/sources.get')).default
  const mcp = (await import('../server/mcp/tools/list_record_comparison')).default
  const app = createApp().use('/comparison', rest).use('/sources', catalog)
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local HTTP fixture address')
  const statements: string[] = []
  const prepare = Database.prototype.prepare
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, text: string) {
    if (this.name === sqlite.name) statements.push(text)
    return prepare.call(this, text)
  })
  try {
    const selected = { ...input, pageSize: 2, businessPage: 2, businessPageSize: 1 }
    const expected = getRecordComparison(db, selected)
    const response = await fetch(`http://127.0.0.1:${address.port}/comparison?queryIds=401,402,403,404&exportBatchIds=701&officialSourceDocumentIds=1&pageSize=2&businessPage=2&businessPageSize=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(expected)
    expect(await mcp.handler(selected as never, {} as never)).toEqual(expected)
    const sources = await fetch(`http://127.0.0.1:${address.port}/sources?kind=query&ids=403,505&pageSize=1`)
    expect(sources.status).toBe(200)
    expect(await sources.json()).toEqual(listRecordComparisonSources(db, { kind: 'query', ids: [403, 505], page: 1, pageSize: 1 }))
    expect(statements.some(q => /\b(?:from|join)\s+"?platform_(?:query|relation)"?(?:\s|$)/i.test(q))).toBe(false)
    expect(statements.some(q => /\b(?:insert|update|delete)\b/i.test(q))).toBe(false)
  } finally { spy.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals() }
})
it('keeps a read snapshot across a normal assignment correction and exposes the fresh attribution next request', async () => {
  sqlite.pragma('journal_mode=WAL')
  const selection = { ...input, queryIds: [401], exportBatchIds: [], enterpriseId: 10 }
  const expected = getRecordComparison(db, selection)
  const reading = readRecordComparison(db, selection)
  const observationId = db.select({ id: targetSchema.platformLegacyRelationAlias.observationId }).from(targetSchema.platformLegacyRelationAlias).where(eq(targetSchema.platformLegacyRelationAlias.oldId, 401)).get()!.id
  const assignment = db.select().from(targetSchema.platformObservationAssignment).where(eq(targetSchema.platformObservationAssignment.observationId, observationId)).get()!
  db.insert(targetSchema.platformObservationAssignment).values({ ...assignment, origin: 'command', actor: { type: 'user', id: 'reviewer' }, revision: 2, enterpriseId: 20, matchBasis: 'manual', nameRaw: 'Attribution correction', usccRaw: 'U20', basis: 'normal explicit assignment correction', recordedAt: '2026-11-03T00:00:00Z' }).run()
  expect(await reading).toEqual(expected)
  const next = await readRecordComparison(db, { ...selection, enterpriseId: 20 })
  expect(next.businessGroups.rows[0]?.versions[0]?.observations[0]?.relation).toMatchObject({ id: 401, enterpriseId: 20, nameRaw: 'Comparison', usccRaw: 'U10' })
  expect(listRecordComparisonSources(db, { kind: 'query', ids: [401], page: 1, pageSize: 1 })).toMatchObject({ rows: [{ confirmedEnterprises: [{ relationId: 401, enterpriseId: 20, nameRaw: 'Comparison', enterpriseName: 'Review', matchBasis: 'manual' }] }] })
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})
it('counts target catalog cooperatively before page-only hydration and keeps the source snapshot during a new commit', async () => {
  const addEmpty = (key: string) => writeNewCollectionTarget(db, { queryText: JSON.stringify({ interface: 'business_list', queryKey: key, rdjb: '2', queriedAt: '2026-11-04T00:00:00Z', status: 'no_record', rawResponse: 'normal synthetic empty source', relations: [] }), evidenceText: null, assignments: [], createdAt: '2026-11-04T00:00:00Z' })
  db.transaction(() => { for (let i = 0; i < 260; i++) addEmpty('catalog748-' + i) })
  const selection = { kind: 'query' as const, page: 2, pageSize: 1 }
  const expected = listRecordComparisonSources(db, selection)
  const statements: string[] = []
  const prepare = Database.prototype.prepare
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, text: string) {
    if (this.name === sqlite.name && this.readonly) statements.push(text)
    return prepare.call(this, text)
  })
  try {
    let settled = false
    const reading = readRecordComparisonSources(db, selection)
    void reading.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    addEmpty('catalog748-next')
    expect(await reading).toEqual(expected)
    expect(statements.some(q => /platform_archive_value/.test(q))).toBe(false)
    expect(statements.some(q => /\b(?:from|join)\s+"?platform_(?:query|relation)"?(?:\s|$)/i.test(q))).toBe(false)
    expect((await readRecordComparisonSources(db, selection)).counts.query).toBe(expected.counts.query + 1)
    const changes = sqlite.prepare('select total_changes() n').get()
    const controller = new AbortController()
    const cancelled = readRecordComparisonSources(db, selection, controller.signal)
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(sqlite.prepare('select total_changes() n').get()).toEqual(changes)
    expect(sqlite.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }])
  } finally { spy.mockRestore() }
})
it('retains separate legacy pagination evidence without upgrading comparison completeness or page provenance', () => {
  const selected = { ...input, queryIds: [507], exportBatchIds: [] }
  const old = drizzle(fixture.old, { schema })
  const expected = getRecordComparison(old, selected)
  expect(expected.coverage[0]).toMatchObject({ completeness: 'unknown', fullRange: false, effectiveConditions: null, reasons: ['collection_evidence_missing'] })
  expect(expected.platformWithoutOfficial.rows[0]?.relation).toMatchObject({ id: 507, sourceRdjb: null, sourcePage: null })
  expect(getRecordComparison(db, selected)).toEqual(expected)
  const filter = { kind: 'query' as const, ids: [507], page: 1, pageSize: 1 }
  expect(listRecordComparisonSources(db, filter)).toEqual(listRecordComparisonSources(old, filter))
})
it('preserves official scope attestations and formal export context without promoting context to historical alignment', async () => {
  const old = drizzle(fixture.old, { schema })
  expect(readComparisonScopeProof(db, officialProofId)).toEqual(readComparisonScopeProof(old, officialProofId))
  const selected = { ...input, proofIds: [officialProofId, proofId] }
  const expected = getRecordComparison(old, selected, resolveVerifiedComparisonEvidence(old, selected.proofIds, selected))
  expect(expected.rows.find(r => r.event.id === 14)).toMatchObject({ classification: 'official_without_correspondence', correspondences: [{ type: 'event_export_context', relationId: null, exportRowId: 701 }] })
  expect(expected.platformWithoutOfficial.rows.find(r => r.relation.id === 402)).toMatchObject({ qualification: 'platform_without_official', proofId: String(officialProofId) })
  expect(await readRecordComparison(db, selected)).toEqual(expected)
  expect(expected.businessGroups.rows.flatMap(g => g.versions.flatMap(v => v.observations)).find(r => r.relation.id === 403)?.correspondences).toMatchObject([{ type: 'recognized_export', requiresRevalidation: false }])
  expect(getRecordComparison(db, { ...input, exportBatchIds: [] }).rows.find(r => r.event.id === 14)?.correspondences).toEqual([])
})

})
