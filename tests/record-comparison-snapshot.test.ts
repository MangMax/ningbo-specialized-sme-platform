import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { initializeDb, schema } from '../db/client'
import { getRecordComparison } from '../server/utils/record-comparison'
import { readRecordComparison, readRecordComparisonSources } from '../server/utils/record-comparison-read'

it('yields during cold source counting and keeps the catalog page in its original readonly snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-catalog-snapshot-'))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'test.db') })
  try {
    db.transaction(tx => { for (let n = 0; n < 512; n++) submitNativePlatformQuery(tx, { rawResponse: '{}', interface: 'business_list', queryKey: `catalog:${n}`, rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' }) })
    const input = { kind: 'query' as const, page: 1, pageSize: 1 }
    const reading = readRecordComparisonSources(db, input)
    let settled = false
    void reading.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    db.transaction(tx => {
      submitNativePlatformQuery(tx, { rawResponse: '{}', interface: 'business_list', queryKey: 'next-commit', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z' })
    })
    expect(await reading).toMatchObject({ total: 512, counts: { query: 512 }, rows: [{ id: 1, label: expect.stringContaining('catalog:0') }] })
    expect(await readRecordComparisonSources(db, input)).toMatchObject({ total: 513, rows: [{ id: 1, label: expect.stringContaining('catalog:0') }] })
    const controller = new AbortController()
    const cancelled = readRecordComparisonSources(db, input, controller.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(db.$client.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0, log: 0, checkpointed: 0 }])
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('cancels a suspended comparison and releases its readonly snapshot before the next read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-cancel-'))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'test.db') })
  try {
    const owner = db.insert(schema.enterprise).values({ name: 'Cancel', nameNorm: 'Cancel' }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Cancel', path: 'cancel.pdf' }).returning().get()
    const query = submitNativePlatformQuery(db, { rawResponse: '{}', interface: 'business_list', queryKey: 'cancel', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial' })
    db.transaction(tx => { for (let n = 0; n < 512; n++) tx.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).run() })
    const input = { queryIds: [query.queryId], exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 1, pageSize: 1 }
    const controller = new AbortController()
    const reading = readRecordComparison(db, input, controller.signal)
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await setImmediate() // suspend with an active native formal cursor
    controller.abort()
    await rejected
    // A leaked cursor/read transaction would pin the pre-commit WAL snapshot.
    db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025 }).run()
    expect(db.$client.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0, log: 0, checkpointed: 0 }])
    expect((await readRecordComparison(db, input)).total).toBe(513)
    await expect(readRecordComparison(db, input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('yields to concurrent work while keeping counts and rows in one readonly SQLite snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-snapshot-'))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'test.db') })
  try {
    const owner = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic' }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic', path: 'synthetic.pdf' }).returning().get()
    const query = submitNativePlatformQuery(db, { rawResponse: '{}', interface: 'business_list', queryKey: 'synthetic', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial' })
    db.transaction(tx => { for (let n = 0; n < 1024; n++) tx.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, sortKey: n }).run() })
    const input = { queryIds: [query.queryId], exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 2, pageSize: 25 }
    const expected = getRecordComparison(db, input)
    const reading = readRecordComparison(db, input)
    let settled = false
    void reading.then(() => { settled = true })
    // Run the writer after source reads but before the native formal cursor opens.
    // A cursor alone cannot protect the earlier source/proof statements.
    await Promise.resolve()
    expect(settled).toBe(false)
    db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2026 }).run()
    await setImmediate()
    expect(settled).toBe(false)
    expect(await reading).toEqual(expected)
    const after = await readRecordComparison(db, input)
    expect(after.counts.officialEventRows).toBe(1025)
    expect(after.total).toBe(1025)
    expect(after.rows.map(row => row.event.id)).toEqual(expected.rows.map(row => row.event.id))
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})
