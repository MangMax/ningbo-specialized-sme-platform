import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { normalizeName } from '../lib/domain'
import { getRecordComparison, listRecordComparisonSources, previewRecordCorrespondenceImpact } from '../server/utils/record-comparison'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-bounded-'))
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  return db
}
// Counts materialized SQLite values, including JSON before ORM decoding. Supplements
// public-result assertions: unrelated archive bytes must never cross into Node.
function returnedBytes(db: ReturnType<typeof useDb>) {
  let bytes = 0
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['all', 'get', 'iterate'] as const) {
      const run = statement[method].bind(statement)
      Object.defineProperty(statement, method, { value: (...params: unknown[]) => {
        const result = run(...params)
        if (method === 'iterate') return (function* () {
          for (const row of result as Iterable<unknown>) { bytes += Buffer.byteLength(JSON.stringify(row) ?? ''); yield row }
        })()
        bytes += Buffer.byteLength(JSON.stringify(result) ?? '')
        return result
      } })
    }
    return statement
  }) as typeof db.$client.prepare
  return () => bytes
}
it('catalog pages preserve scope metadata without materializing archive bodies', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Official', path: 'synthetic.pdf' }).returning().get()
  const ids: number[] = []
  for (let n = 0; n < 12; n++) ids.push(db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: `q:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'RAW'.repeat(65536), collectionEvidence: { completeness: 'partial', fullRange: false, effectiveConditions: { combination: 'and', name: 'Selected' }, rows: [{ payload: 'BODY'.repeat(32768) }] } as never }).returning({ id: schema.platformQuery.id }).get().id)
  const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'test.xlsx', sha256: 'a'.repeat(64), importStatus: 'failed' }).returning().get()
  const bytes = returnedBytes(db)
  const page = listRecordComparisonSources(db, { kind: 'query', page: 3, pageSize: 2 })
  expect(page.rows).toMatchObject(ids.slice(4, 6).map(id => ({ id, kind: 'query', completeness: 'partial', fullRange: false, conditions: { combination: 'and', name: 'Selected' }, selectable: true })))
  expect(page.counts).toEqual({ official_document: 1, query: 12, export_batch: 1 })
  expect(page.total).toBe(12)
  expect(listRecordComparisonSources(db, { page: 1, pageSize: 2 }).rows).toMatchObject([{ id: doc.id, kind: 'official_document' }, { id: ids[0], kind: 'query' }])
  expect(listRecordComparisonSources(db, { page: 7, pageSize: 2 }).rows).toMatchObject([{ id: ids[11], kind: 'query' }, { id: batch.id, kind: 'export_batch', selectable: false }])
  expect(bytes()).toBeLessThan(65536)
})
it('attaches confirmed relation identities and raw platform names only to the displayed query page', () => {
  const db = fixture()
  const makeEnterprise = (name: string) => db.insert(schema.enterprise).values({ name, nameNorm: normalizeName(name) }).returning().get()
  const makeQuery = (key: string) => db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: key, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'success' }).returning().get()
  const survivor = makeEnterprise('合成111-归并')
  const second = makeEnterprise('第二家')
  const outside = makeEnterprise('页外企业')
  const first = makeQuery('q:first')
  const secondQuery = makeQuery('q:second')
  const outsideQuery = makeQuery('q:outside')
  const mergedRelation = db.insert(schema.platformRelation).values({ queryId: first.id, sequenceNo: 1, enterpriseId: survivor.id, nameRaw: '合成111-归并旧主体', verificationStatus: 'confirmed', matchBasis: 'manual' }).returning().get()
  db.insert(schema.platformRelation).values({ queryId: first.id, sequenceNo: 2, enterpriseId: second.id, nameRaw: '第二家', verificationStatus: 'confirmed', matchBasis: 'uscc' }).run()
  db.insert(schema.platformRelation).values({ queryId: secondQuery.id, sequenceNo: 1, enterpriseId: null, nameRaw: '待关联原行', verificationStatus: 'pending', matchBasis: 'none' }).run()
  db.insert(schema.platformRelation).values({ queryId: outsideQuery.id, sequenceNo: 1, enterpriseId: outside.id, nameRaw: '页外原行', verificationStatus: 'confirmed', matchBasis: 'uscc' }).run()
  db.insert(schema.enterpriseAlias).values({
    enterpriseId: survivor.id,
    name: '合成111-归并旧主体',
    nameNorm: normalizeName('合成111-归并旧主体'),
    sourceKind: 'platform_business',
    sourceRefId: mergedRelation.id,
    verificationStatus: 'confirmed',
    note: '归并自 enterprise:8（合成111-归并旧主体）',
  }).run()
  const page = listRecordComparisonSources(db, { kind: 'query', page: 1, pageSize: 2 })
  expect(page.rows.map(row => row.id)).toEqual([first.id, secondQuery.id])
  expect(page.rows[0]).toMatchObject({
    confirmedEnterprises: [
      { relationId: mergedRelation.id, sequenceNo: 1, enterpriseId: survivor.id, enterpriseName: '合成111-归并', nameRaw: '合成111-归并旧主体', aliasConfirmed: true, mergedFromEnterpriseId: 8 },
      { sequenceNo: 2, enterpriseId: second.id, enterpriseName: '第二家', nameRaw: '第二家', aliasConfirmed: false, mergedFromEnterpriseId: null },
    ],
    recordNames: [],
  })
  expect(page.rows[1]).toMatchObject({ confirmedEnterprises: [], recordNames: ['待关联原行'] })
  expect(page.rows.flatMap(row => row.kind === 'query' ? row.confirmedEnterprises : []).some(row => row.enterpriseId === outside.id)).toBe(false)
  expect(listRecordComparisonSources(db, { kind: 'query', page: 2, pageSize: 2 }).rows).toMatchObject([
    { id: outsideQuery.id, confirmedEnterprises: [{ enterpriseId: outside.id, enterpriseName: '页外企业', nameRaw: '页外原行' }] },
  ])
  expect(listRecordComparisonSources(db, { kind: 'official_document', page: 1, pageSize: 10 }).rows).toEqual([])
})

it('source catalog reads only matching confirmed alias notes for its query page', () => {
  const db = fixture()
  const owner = db.insert(schema.enterprise).values({ name: 'Current', nameNorm: 'Current' }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'selected', queriedAt: '2026-10-18T00:00:00Z' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: owner.id, nameRaw: 'Previous', verificationStatus: 'confirmed', matchBasis: 'manual' }).returning().get()
  db.insert(schema.enterpriseAlias).values({ enterpriseId: owner.id, name: 'Previous', nameNorm: normalizeName('Previous'), sourceKind: 'manual', verificationStatus: 'confirmed', note: '归并自 enterprise:8' }).run()
  db.insert(schema.enterpriseAlias).values({ enterpriseId: owner.id, name: 'Irrelevant', nameNorm: normalizeName('Irrelevant'), sourceKind: 'manual', verificationStatus: 'confirmed', note: 'UNRELATED'.repeat(131072) }).run()
  const bytes = returnedBytes(db)
  const page = listRecordComparisonSources(db, { kind: 'query', page: 1, pageSize: 1 })
  expect(page.rows).toMatchObject([{ id: query.id, confirmedEnterprises: [{ relationId: relation.id, enterpriseId: owner.id, aliasConfirmed: true, mergedFromEnterpriseId: 8 }] }])
  expect(bytes()).toBeLessThan(65536)
})

it('comparison preserves all selected relations and formal event uncertainty as unrelated archives grow', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf' }).returning().get()
  const owner = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic', usccNorm: '91330211255994475A' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3 }).run()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'SELECTED_RAW'.repeat(65536) }).returning({ id: schema.platformQuery.id }).get()
  const relations = [1, 2].map(sequenceNo => db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo, enterpriseId: sequenceNo === 1 ? owner.id : null, usccRaw: owner.usccNorm, rawFields: { sblx: '复核', cszt: '终审通过', sqsj: '2025-11-21 09:54:16', year: true, body: 'SELECTED_RELATION'.repeat(32768) } }).returning({ id: schema.platformRelation.id }).get().id)
  const input = { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 1, pageSize: 1 }
  const expected = getRecordComparison(db, input)
  for (let n = 0; n < 12; n++) {
    const q = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: `unrelated:${n}`, rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', rawResponse: 'UNRELATED'.repeat(65536) }).returning({ id: schema.platformQuery.id }).get()
    db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1, rawFields: { body: 'UNRELATED'.repeat(65536) } }).run()
  }
  const bytes = returnedBytes(db)
  const actual = getRecordComparison(db, input)
  expect(actual).toEqual(expected)
  expect(actual.rows).toMatchObject([{ event: { id: event.id }, evidence: [{ sourceFile: doc.path, page: 3 }], classification: 'unresolved' }])
  expect(actual.platformWithoutOfficial.rows.map(row => row.relation.id)).toEqual(relations)
  expect(actual.platformWithoutOfficial.rows.map(row => row.relation)).toMatchObject([
    { declareKind: 'review', status: '终审通过', appliedAt: '2025-11-21 09:54:16', year: null, normalizationConflicts: [] },
    { declareKind: 'review', status: '终审通过', appliedAt: '2025-11-21 09:54:16', year: null, normalizationConflicts: [] },
  ])
  expect(actual.counts).toMatchObject({ distinctPlatformRows: 2, unresolvedPlatformRows: 2, unresolved: 1 })
  expect(bytes()).toBeLessThan(65536)
})

it('streams global formal classifications without hydrating history evidence outside the displayed page', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf' }).returning().get()
  const owner = db.insert(schema.enterprise).values({ name: 'Same name', nameNorm: 'Same name' }).returning().get()
  const other = db.insert(schema.enterprise).values({ name: 'Same name', nameNorm: 'Same name' }).returning().get()
  const records = [owner, other].map(e => db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme', nameRaw: 'Same name' }).returning().get())
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial' }).returning().get()
  let first = 0
  db.transaction(tx => {
    for (let n = 0; n < 1024; n++) {
      const event = tx.insert(schema.recordEvent).values({ recordId: records[n ? 1 : 0]!.id, eventType: 'award', year: 2024 }).returning().get()
      if (!n) first = event.id
      tx.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: n ? 'unselected.pdf' : doc.path, attachment: 'Full original attachment '.repeat(16), page: n + 1 }).run()
    }
  })
  const bytes = returnedBytes(db)
  const result = getRecordComparison(db, { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], enterpriseId: owner.id, page: 1, pageSize: 1 })
  expect(result.total).toBe(1)
  expect(result.counts).toMatchObject({ officialEventRows: 1024, distinctEnterpriseTitles: 2, unresolved: 1024 })
  expect(result.rows).toMatchObject([{ event: { id: first }, record: { id: records[0]!.id, enterpriseId: owner.id }, reasons: ['official_coverage_unproved'], evidence: [{ sourceFile: doc.path, page: 1, attachment: 'Full original attachment '.repeat(16), inSelectedSource: true }] }])
  // Supplemental resource assertion at the native boundary, alongside the public
  // counts/rows above. Full evidence for 1024 unrendered events is not required.
  expect(bytes()).toBeLessThan(65536)
})

it('stored current proof revalidation reads its original sources without unrelated raw bodies', async () => {
  const { readComparisonScopeProof } = await import('../server/utils/comparison-scope-proof')
  const db = fixture()
  const file = db.insert(schema.storedFile).values({ relPath: 'freeze.txt', filename: 'freeze.txt', ext: 'txt', bytes: 8, sha256: 'c'.repeat(64), source: 'miit', kind: 'export' }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'scope:selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'no_record', collectionEvidence: { source: 'queryBusList', status: 'no_record', queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:01:00Z', completeness: 'complete', fullRange: true, effectiveConditions: { combination: 'and' }, titleScope: { rdjb: ['2'] }, pages: [{ rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 0 }], unfinished: [], rows: [] } as never }).returning().get()
  const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'empty.xlsx', sha256: 'a'.repeat(64), importStatus: 'imported' }).returning().get()
  const evidence = { queryId: query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256', scope: { queryAccount: 'synthetic', exportAccount: 'synthetic', queryRegion: 'synthetic', exportRegion: 'synthetic', queryFilters: { combination: 'and' }, exportFilters: { combination: 'and' }, windowStart: '2026-10-18T00:00:00Z', windowEnd: '2026-10-18T01:00:00Z', platformVersion: 'synthetic', freezeReference: file.relPath, freezeFileId: file.id, freezeSha256: file.sha256 } }
  const proof = db.insert(schema.comparisonScopeProof).values({ kind: 'current_source_equivalence', evidence, sourceFingerprint: 'candidate-fingerprint', createdAt: '2026-10-18T00:00:00Z' }).returning().get()
  for (let n = 0; n < 8; n++) db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: `irrelevant:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', rawResponse: 'UNRELATED'.repeat(65536) }).run()
  const bytes = returnedBytes(db)
  expect(readComparisonScopeProof(db, proof.id)).toMatchObject({ status: 'candidate', valid: false, sourceSummary: { queryId: query.id, queryRowCount: 0, exportBatchId: batch.id, exportRowCount: 0 } })
  expect(bytes()).toBeLessThan(65536)
})

it('comparison ignores out-of-scope candidate proof bodies before source revalidation', async () => {
  const { resolveVerifiedComparisonEvidence } = await import('../server/utils/comparison-scope-proof')
  const db = fixture()
  const q = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'unselected-proof', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', rawResponse: 'UNSELECTED'.repeat(65536) }).returning({ id: schema.platformQuery.id }).get()
  const proof = db.insert(schema.comparisonScopeProof).values({ kind: 'current_source_equivalence', evidence: { queryId: q.id, exportBatchId: 9999 }, sourceFingerprint: 'candidate', createdAt: '2026-10-18T00:00:00Z' }).returning().get()
  const bytes = returnedBytes(db)
  expect(resolveVerifiedComparisonEvidence(db, [proof.id], { queryIds: [9999], exportBatchIds: [], officialSourceDocumentIds: [] })).toEqual({ officialScopes: [], currentScopes: [] })
  expect(bytes()).toBeLessThan(65536)
})

it('rejects a post-cutoff query before decoding its selected archive body', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2026-10-18' }).returning().get()
  const q = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'future', rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', collectionEvidence: { rows: [{ payload: 'FUTURE'.repeat(65536) }] } as never }).returning({ id: schema.platformQuery.id }).get()
  const bytes = returnedBytes(db)
  expect(() => getRecordComparison(db, { queryIds: [q.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], asOf: '2026-10-18T16:30:00Z', page: 1, pageSize: 25 })).toThrow('source_set_missing_or_out_of_scope')
  expect(bytes()).toBeLessThan(65536)
})

it('legacy impact pages visible decisions without reading unrelated reason notes', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2026-10-18' }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' }).returning().get()
  const owner = db.insert(schema.enterprise).values({ name: 'Selected', nameNorm: 'Selected' }).returning().get()
  const outside = db.insert(schema.enterprise).values({ name: 'Outside', nameNorm: 'Outside' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, attachment: 'UNNEEDED_EVIDENCE'.repeat(65536), page: 1 }).run()
  const included = db.insert(schema.differenceReason).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-10-18T01:00:00Z' }).returning().get()
  db.insert(schema.differenceReason).values({ enterpriseId: outside.id, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'needs_review', reasonNote: 'UNRELATED'.repeat(131072), recordedAt: '2026-10-18T01:00:00Z' }).run()
  db.insert(schema.differenceReason).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-10-20T01:00:00Z' }).run()
  const bytes = returnedBytes(db)
  const result = previewRecordCorrespondenceImpact(db, { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], enterpriseId: owner.id, asOf: '2026-10-19T00:00:00Z', page: 1, pageSize: 1 })
  expect(result.counts.legacyRows).toBe(2)
  expect(result.total).toBe(1)
  expect(result.rows).toMatchObject([{ id: included.id, original: { enterpriseId: owner.id }, possibleEventIds: [event.id] }])
  expect(result.unresolved).toMatchObject([{ eventId: event.id }])
  expect(bytes()).toBeLessThan(65536)
})


it('keeps legacy JavaScript asOf semantics for fractional milliseconds, offsets and historical dates', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2026-10-18' }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' }).returning().get()
  const owner = db.insert(schema.enterprise).values({ name: 'Selected', nameNorm: 'Selected' }).returning().get()
  const times = [
    '2026-10-20T00:00:00.001Z', // first real millisecond
    '2026-10-20T00:00:00.0009Z', // JS truncates, SQLite rounds
    '2026-10-20T08:00:00.000999999999999999999999999999+08:00',
    '2026-10-20', // legacy whole-day inclusion
    'invalid historical timestamp',
    '2026-10-20T00:00:00.123999999999999999Z',
    '2026-10-20T00:00:00.124Z',
    '2026-10-20T00:00:00.000-01:00',
    '0000badbad', // ten characters: legacy lexical day comparison
    '2026-02-30T00:00:00Z', // Date.parse normalizes the historical day
    '2026-10-20T25:00:00Z',
    'Tue, 20 Oct 2026 00:00:00 GMT',
  ]
  const ids = times.map(recordedAt => db.insert(schema.differenceReason).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', reasonNote: 'UNREAD_NOTE'.repeat(10000), recordedAt }).returning({ id: schema.differenceReason.id }).get().id)
  const bytes = returnedBytes(db)
  const input = { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], enterpriseId: owner.id, pageSize: 2 }
  for (const [asOf, indexes] of [
    ['2026-10-20T00:00:00.0009Z', [1, 3, 8, 9, 11]],
    ['2026-10-20T08:00:00.001+08:00', [0, 1, 3, 8, 9, 11]],
    ['2026-10-20T00:00:00.1234Z', [0, 1, 3, 5, 8, 9, 11]],
    ['2026-10-20T00:00:00.124Z', [0, 1, 3, 5, 6, 8, 9, 11]],
    ['2026-10-19T23:59:59.999999999Z', [8, 9]],
    ['2026-10-20T01:00:00Z', [0, 1, 2, 3, 5, 6, 7, 8, 9, 11]],
  ] as const) {
    const expected = indexes.map(index => ids[index])
    const found: number[] = []
    for (let page = 1; page <= Math.ceil(expected.length / 2) + 1; page++) {
      const result = previewRecordCorrespondenceImpact(db, { ...input, asOf, page })
      expect(result.total, asOf).toBe(expected.length)
      expect(result.counts.legacyRows, asOf).toBe(expected.length)
      expect(result.rows.map(row => row.id), `${asOf} page ${page}`).toEqual(expected.slice((page - 1) * 2, page * 2))
      found.push(...result.rows.map(row => row.id))
    }
    expect(found, asOf).toEqual(expected)
  }
  const unfiltered = previewRecordCorrespondenceImpact(db, { ...input, page: 1 })
  expect(unfiltered.total).toBe(times.length)
  expect(unfiltered.counts.legacyRows).toBe(times.length)
  expect(bytes()).toBeLessThan(65536)
})
