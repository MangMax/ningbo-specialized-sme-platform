import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { getRecordComparison, listRecordComparisonSources, previewRecordCorrespondenceImpact } from '../../../server/utils/record-comparison'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach(fn => fn()))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-comparison-bounded-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2024-01-01' }).returning().get()
  const owner = db.insert(schema.enterprise).values({ name: 'Source owner', nameNorm: 'Source owner' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path }).run()
  return { db, doc }
}

it('pages native collection sources without exposing original archive bodies', () => {
  const { db } = fixture()
  const ids = Array.from({ length: 12 }, (_, n) => submitNativePlatformQuery(db, {
    interface: 'business_list', queryKey: `q:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'PRIVATE_ARCHIVE'.repeat(65536),
  }).queryId)
  const page = listRecordComparisonSources(db, { kind: 'query', page: 3, pageSize: 2 })
  expect(page.total).toBe(12)
  expect(page.rows.map(row => row.id)).toEqual(ids.slice(4, 6))
  expect(page.counts).toEqual({ official_document: 1, query: 12, export_batch: 0 })
  expect(JSON.stringify(page)).not.toContain('PRIVATE_ARCHIVE')
})

it('keeps selected platform rows and formal pagination independent and rejects future collections', () => {
  const { db, doc } = fixture()
  const owner = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  for (let n = 0; n < 4; n++) {
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
    db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: n + 1 }).run()
  }
  const selected = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', rawResponse: 'PRIVATE_RESPONSE', relations: [{ sequenceNo: 1, enterpriseId: owner.id, verificationStatus: 'confirmed', matchBasis: 'manual', relationKey: 'B1', rawFields: { id: 'B1', secret: 'PRIVATE_ROW' } }] })
  const future = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: 'future', rdjb: '2', queriedAt: '2026-10-20T00:00:00Z', rawResponse: '{}' })
  const input = { queryIds: [selected.queryId], enterpriseId: owner.id, exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 2, pageSize: 1 }
  const out = getRecordComparison(db, input)
  expect(out.total).toBe(4)
  expect(out.rows).toHaveLength(1)
  expect(out.platformWithoutOfficial.rows.map(row => row.relation.id)).toEqual(selected.relationIds)
  expect(out.businessCounts).toMatchObject({ records: 1, versions: 1, observations: 1 })
  expect(JSON.stringify(out)).not.toMatch(/PRIVATE_RESPONSE|PRIVATE_ROW/)
  expect(() => getRecordComparison(db, { ...input, queryIds: [future.queryId], asOf: '2026-10-19T00:00:00Z' })).toThrow('source_set_missing_or_out_of_scope')
})

it('pages legacy decision originals while excluding future and unrelated decisions', () => {
  const { db, doc } = fixture()
  const owner = db.insert(schema.enterprise).values({ name: 'Selected', nameNorm: 'Selected' }).returning().get()
  const outside = db.insert(schema.enterprise).values({ name: 'Outside', nameNorm: 'Outside' }).returning().get()
  const q = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', rawResponse: '{}' })
  const base = { titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-10-18T01:00:00Z' } as const
  const included = db.insert(schema.differenceReason).values({ ...base, enterpriseId: owner.id, reasonNote: 'Original reviewed note' }).returning().get()
  db.insert(schema.differenceReason).values({ ...base, enterpriseId: owner.id, recordedAt: '2026-10-20T00:00:00Z' }).run()
  db.insert(schema.differenceReason).values({ ...base, enterpriseId: outside.id, reasonNote: 'UNRELATED_PRIVATE_NOTE' }).run()
  const result = previewRecordCorrespondenceImpact(db, { queryIds: [q.queryId], exportBatchIds: [], officialSourceDocumentIds: [doc.id], enterpriseId: owner.id, asOf: '2026-10-19T00:00:00Z', page: 1, pageSize: 1 })
  expect(result.total).toBe(1)
  expect(result.rows).toMatchObject([{ id: included.id, original: { enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' } }])
  expect(JSON.stringify(result)).not.toContain('UNRELATED_PRIVATE_NOTE')
})

it('keeps legacy JavaScript asOf semantics for fractional milliseconds, offsets and historical dates', () => {
  const { db } = fixture()
  const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2026-10-18' }).returning().get()
  const query = submitNativePlatformQuery(db, { rawResponse: '{}', ...{ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' } })
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
  const input = { queryIds: [query.queryId], exportBatchIds: [], officialSourceDocumentIds: [doc.id], enterpriseId: owner.id, pageSize: 2 }
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
})
