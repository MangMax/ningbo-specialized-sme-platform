import { expect, it } from 'vitest'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { readPostgresRecordComparison, previewPostgresRecordCorrespondenceImpact } from '../../../layers/sme-roster/server/utils/record-comparison-postgres'
import { readPostgresRecordComparisonSources } from '../../../layers/sme-roster/server/utils/record-comparison-catalog-postgres'
import * as schema from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { sourceDocument } from '../../../db/postgresql/official-evidence-tables'

const openDatabase = useIsolatedPostgresCases()

async function fixture() {
  const db = openDatabase()
  const doc = singlePostgresFixtureRow(await db.insert(sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2024-01-01' }).returning())
  const owner = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'Source owner', nameNorm: 'Source owner' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
  await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path })
  return { db, doc }
}

it('pages native collection sources without exposing original archive bodies', async () => {
  const { db } = await fixture()
  const ids = [] as number[]
  for (let n = 0; n < 12; n++) {
    const seeded = await seedPostgresPlatformQuery(db, {
    interface: 'business_list', queryKey: `q:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial', rawResponse: 'PRIVATE_ARCHIVE'.repeat(65536),
  })
    ids.push(seeded.queryId)
  }
  const page = await readPostgresRecordComparisonSources(db, { kind: 'query', page: 3, pageSize: 2 })
  expect(page.total).toBe(12)
  expect(page.rows.map(row => row.id)).toEqual(ids.slice(4, 6))
  expect(page.counts).toEqual({ official_document: 1, query: 12, export_batch: 0 })
  expect(JSON.stringify(page)).not.toContain('PRIVATE_ARCHIVE')
})

it('keeps selected platform rows and formal pagination independent and rejects future collections', async () => {
  const { db, doc } = await fixture()
  const owner = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: 'specialized_sme' }).returning())
  for (let n = 0; n < 4; n++) {
    const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
    await db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: n + 1 })
  }
  const selected = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', rawResponse: 'PRIVATE_RESPONSE', relations: [{ sequenceNo: 1, enterpriseId: owner.id, verificationStatus: 'confirmed', matchBasis: 'manual', relationKey: 'B1', rawFields: { id: 'B1', secret: 'PRIVATE_ROW' } }] })
  const future = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'future', rdjb: '2', queriedAt: '2026-10-20T00:00:00Z', rawResponse: '{}' })
  const input = { queryIds: [selected.queryId], enterpriseId: owner.id, exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 2, pageSize: 1 }
  const out = await readPostgresRecordComparison(db, input)
  expect(out.total).toBe(4)
  expect(out.rows).toHaveLength(1)
  expect(out.platformWithoutOfficial.rows.map(row => row.relation.id)).toEqual(selected.relationIds)
  expect(out.businessCounts).toMatchObject({ records: 1, versions: 1, observations: 1 })
  expect(JSON.stringify(out)).not.toMatch(/PRIVATE_RESPONSE|PRIVATE_ROW/)
  await expect(readPostgresRecordComparison(db, { ...input, queryIds: [future.queryId], asOf: '2026-10-19T00:00:00Z' })).rejects.toThrow('source_set_missing_or_out_of_scope')
})

it('pages legacy decision originals while excluding future and unrelated decisions', async () => {
  const { db, doc } = await fixture()
  const owner = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'Selected', nameNorm: 'Selected' }).returning())
  const outside = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'Outside', nameNorm: 'Outside' }).returning())
  const q = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', rawResponse: '{}' })
  const base = { titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', createdAt: '2026-10-18T01:00:00Z', recordedAt: '2026-10-18T01:00:00Z' } as const
  const included = singlePostgresFixtureRow(await db.insert(schema.differenceReason).values({ ...base, enterpriseId: owner.id, reasonNote: 'Original reviewed note' }).returning())
  await db.insert(schema.differenceReason).values({ ...base, enterpriseId: owner.id, createdAt: '2026-10-20T00:00:00Z', recordedAt: '2026-10-20T00:00:00Z' })
  await db.insert(schema.differenceReason).values({ ...base, enterpriseId: outside.id, reasonNote: 'UNRELATED_PRIVATE_NOTE' })
  const result = await previewPostgresRecordCorrespondenceImpact(db, { queryIds: [q.queryId], exportBatchIds: [], officialSourceDocumentIds: [doc.id], enterpriseId: owner.id, asOf: '2026-10-19T00:00:00Z', page: 1, pageSize: 1 })
  expect(result.total).toBe(1)
  expect(result.rows).toMatchObject([{ id: included.id, original: { enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' } }])
  expect(JSON.stringify(result)).not.toContain('UNRELATED_PRIVATE_NOTE')
})

it('keeps legacy JavaScript asOf semantics for fractional milliseconds, offsets and historical dates', async () => {
  const { db } = await fixture()
  const doc = singlePostgresFixtureRow(await db.insert(sourceDocument).values({ source: 'jxj', title: 'Selected', path: 'selected.pdf', issueDate: '2026-10-18' }).returning())
  const query = await seedPostgresPlatformQuery(db, { rawResponse: '{}', ...{ interface: 'business_list', queryKey: 'selected', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' } })
  const owner = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: 'Selected', nameNorm: 'Selected' }).returning())
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
  const ids: number[] = []
  for (const recordedAt of times) ids.push(singlePostgresFixtureRow(await db.insert(schema.differenceReason).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'needs_review', reasonNote: 'UNREAD_NOTE'.repeat(10000), recordedAt, createdAt: recordedAt }).returning({ id: schema.differenceReason.id })).id)
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
      const result = await previewPostgresRecordCorrespondenceImpact(db, { ...input, asOf, page })
      expect(result.total, asOf).toBe(expected.length)
      expect(result.counts.legacyRows, asOf).toBe(expected.length)
      expect(result.rows.map(row => row.id), `${asOf} page ${page}`).toEqual(expected.slice((page - 1) * 2, page * 2))
      found.push(...result.rows.map(row => row.id))
    }
    expect(found, asOf).toEqual(expected)
  }
  const unfiltered = await previewPostgresRecordCorrespondenceImpact(db, { ...input, page: 1 })
  expect(unfiltered.total).toBe(times.length)
  expect(unfiltered.counts.legacyRows).toBe(times.length)
})
