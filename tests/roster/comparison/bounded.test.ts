import { expect, it } from 'vitest'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { readPostgresRecordComparison } from '../../../layers/sme-roster/server/utils/record-comparison-postgres'
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
