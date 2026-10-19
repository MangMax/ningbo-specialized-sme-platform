import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { getRecordComparison, listRecordComparisonSources } from '../server/utils/record-comparison'

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
it('comparison preserves all selected relations and formal event uncertainty as unrelated archives grow', () => {
  const db = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf' }).returning().get()
  const owner = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic', usccNorm: '91330211255994475A' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3 }).run()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'SELECTED_RAW'.repeat(65536) }).returning({ id: schema.platformQuery.id }).get()
  const relations = [1, 2].map(sequenceNo => db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo, enterpriseId: sequenceNo === 1 ? owner.id : null, usccRaw: owner.usccNorm, rawFields: { body: 'SELECTED_RELATION'.repeat(32768) } }).returning({ id: schema.platformRelation.id }).get().id)
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
  expect(actual.counts).toMatchObject({ distinctPlatformRows: 2, unresolvedPlatformRows: 2, unresolved: 1 })
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
