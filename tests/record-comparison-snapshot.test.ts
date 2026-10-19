import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import { getRecordComparison } from '../server/utils/record-comparison'
import { readRecordComparison } from '../server/utils/record-comparison-read'

it('yields to concurrent work while keeping counts and rows in one readonly SQLite snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-snapshot-'))
  const db = useDb({ dbPath: join(dir, 'test.db') })
  try {
    const owner = db.insert(schema.enterprise).values({ name: 'Synthetic', nameNorm: 'Synthetic' }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
    const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic', path: 'synthetic.pdf' }).returning().get()
    const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'synthetic', rdjb: '2', queriedAt: '2026-10-18T00:00:00Z', status: 'partial' }).returning().get()
    db.transaction(tx => { for (let n = 0; n < 1024; n++) tx.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, sortKey: n }).run() })
    const input = { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id], page: 2, pageSize: 25 }
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
