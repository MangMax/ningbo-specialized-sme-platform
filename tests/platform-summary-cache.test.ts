import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { listPlatformQueries, type PlatformQueryFilter } from '../lib/platform/read'
import { createPlatformSummaryCache } from '../server/utils/platform-summary-cache'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'summary-cache-89-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = useDb({ dbPath: join(dir, 'db.sqlite') })
  cleanup.push(() => db.$client.close())
  for (const [index, status] of (['success', 'partial', 'failed', 'no_record', 'not_queried'] as const).entries()) {
    db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: `synthetic:${index}`, queriedAt: `2026-10-19T00:00:0${index}Z`, status, rawResponse: 'private raw', collectionEvidence: { private: 'raw' } as never }).run()
  }
  return db
}
function cache(options: Parameters<typeof createPlatformSummaryCache>[0] = {}) {
  const reader = createPlatformSummaryCache(options)
  cleanup.push(() => reader.close())
  return reader
}

it('normalized repeated summaries hit without retaining mutable results or original evidence', () => {
  const db = fixture(), reader = cache()
  const expected = listPlatformQueries(db, { view: 'summary' })
  const first = reader.read(db, { view: 'summary' })
  expect(first).toEqual(expected)
  first.rows[0]!.query.status = 'mutated'
  const second = reader.read(db, { page: 1.9, pageSize: 25.9, includeRawResponse: false, view: 'summary' })
  expect(second).toEqual(expected)
  expect(second.counts).toEqual({ success: 1, partial: 1, failed: 1, no_record: 1, not_queried: 1 })
  expect(second.rows.map(row => row.query.id)).toEqual([5, 4, 3, 2, 1])
  expect(JSON.stringify(second)).not.toContain('private raw')
  expect(reader.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1, sources: 1 })
})

it('entry eviction uses least recently read order and evicted requests safely refill', () => {
  const db = fixture(), reader = cache({ maxEntries: 2 })
  const read = (pageSize: number) => reader.read(db, { view: 'summary', pageSize })
  read(1); read(2); read(1); read(3)
  expect(reader.stats()).toMatchObject({ entries: 2, hits: 1, misses: 3, evictions: 1 })
  expect(read(2).rows.map(row => row.query.id)).toEqual([5, 4])
  expect(reader.stats()).toMatchObject({ entries: 2, misses: 4, evictions: 2 })
})

it('byte and per-entry limits count encoded data and admit only at the exact budget', () => {
  const db = fixture(), args = { view: 'summary' as const, pageSize: 5 }
  db.$client.prepare('UPDATE platform_query SET query_key=? WHERE id=5').run('界🙂'.repeat(400))
  const probe = cache(); const expected = probe.read(db, args)
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(JSON.stringify(expected).length)
  const charge = probe.stats().bytes
  expect(charge).toBeGreaterThan(Buffer.byteLength(JSON.stringify(expected)))
  const exact = cache({ maxBytes: charge, maxEntryBytes: charge })
  expect(exact.read(db, args)).toEqual(expected)
  expect(exact.stats()).toMatchObject({ entries: 1, bytes: charge })
  for (const options of [{ maxBytes: charge - 1 }, { maxEntryBytes: charge - 1 }]) {
    const under = cache(options)
    expect(under.read(db, args)).toEqual(expected)
    expect(under.read(db, args)).toEqual(expected)
    expect(under.stats()).toMatchObject({ entries: 0, bytes: 0, hits: 0, misses: 2 })
  }
  const churn = cache({ maxBytes: charge })
  for (const pageSize of [1, 2, 3, 4, 5]) churn.read(db, { ...args, pageSize })
  expect(churn.stats().bytes).toBeLessThanOrEqual(charge)
  expect(churn.stats().evictions).toBeGreaterThan(0)
})

it('TTL expires at the boundary and hits do not extend the committed value lifetime', () => {
  const db = fixture(); let now = 0
  const reader = cache({ ttlMs: 100, now: () => now }), args = { view: 'summary' as const }
  const expected = reader.read(db, args)
  now = 99; expect(reader.read(db, args)).toEqual(expected)
  expect(reader.stats()).toMatchObject({ hits: 1, misses: 1 })
  now = 100; expect(reader.read(db, args)).toEqual(expected)
  expect(reader.stats()).toMatchObject({ hits: 1, misses: 2, entries: 1 })
  now = 201; reader.read(db, { view: 'summary', pageSize: 1 })
  expect(reader.stats().entries).toBe(1)
})

it('same-connection commits invalidate both independent readers while rollback never publishes', () => {
  const db = fixture(), a = cache(), b = cache(), args = { view: 'summary' as const }
  const before = a.read(db, args); b.read(db, args)
  db.$client.exec("BEGIN; UPDATE platform_query SET status='partial' WHERE id=5")
  // A transactional caller may read its own writes, but may not fill or consume a shared entry.
  expect(a.read(db, args).rows[0]!.query.status).toBe('partial')
  db.$client.exec('ROLLBACK')
  expect(a.read(db, args)).toEqual(before)
  expect(b.read(db, args)).toEqual(before)
  expect(b.stats()).toMatchObject({ hits: 1, misses: 1 })
  db.$client.exec("BEGIN; UPDATE platform_query SET status='partial' WHERE id=5; COMMIT")
  for (const reader of [a, b]) {
    const committed = reader.read(db, args)
    expect(committed.rows[0]!.query.status).toBe('partial')
    expect(committed.counts).toEqual({ success: 1, partial: 2, failed: 1, no_record: 1 })
    expect(reader.stats().misses).toBe(2)
  }
})

it('unsafe filters, raw reads, no-store and sensitive failures bypass result storage', () => {
  const db = fixture(), reader = cache(), summary = { view: 'summary' as const }
  const cases: PlatformQueryFilter[] = [
    {}, { ...summary, includeRawResponse: true }, { ...summary, page: 2 }, { ...summary, pageSize: 51 },
    { ...summary, interface: 'recognized_list' as const }, { ...summary, titleCode: 'specialized_sme' },
    { ...summary, uscc: 'synthetic:0' }, { ...summary, queryKey: 'synthetic:0' }, { ...summary, queryId: 1 },
    { ...summary, enterpriseId: 1 }, { ...summary, status: 'failed' as const },
  ]
  for (const args of cases) {
    if (args.includeRawResponse) expect(() => reader.read(db, args)).toThrow('Invalid view')
    else expect(reader.read(db, args)).toEqual(listPlatformQueries(db, args))
  }
  reader.read(db, summary, { allowStore: false })
  expect(reader.stats()).toMatchObject({ entries: 0, hits: 0, misses: 0, sources: 0 })
  db.$client.exec("UPDATE platform_query SET failure_reason='sensitive synthetic error' WHERE id=5")
  const result = reader.read(db, summary)
  expect(result.rows[0]!.query.failureReason).toBe('sensitive synthetic error')
  expect(reader.stats().entries).toBe(0)
})

it('external commits, pending writes, rollback and restart preserve committed public results', () => {
  const db = fixture(), a = cache(), b = cache(), args = { view: 'summary' as const }
  const writer = new Database(db.$client.name); cleanup.push(() => writer.close())
  const before = a.read(db, args); b.read(db, args)
  writer.exec("BEGIN; UPDATE platform_query SET status='partial' WHERE id=5")
  expect(a.read(db, args)).toEqual(before); expect(b.read(db, args)).toEqual(before)
  const cold = cache()
  expect(cold.read(db, args)).toEqual(before)
  expect(cold.stats()).toMatchObject({ hits: 0, misses: 1, entries: 1 })
  writer.exec('ROLLBACK')
  expect(a.read(db, args)).toEqual(before)
  expect(a.stats()).toMatchObject({ misses: 1, hits: 2 })
  writer.exec("BEGIN; UPDATE platform_query SET status='partial' WHERE id=5; INSERT INTO platform_relation(query_id,sequence_no,created_at) VALUES(5,1,'2026-10-19'); COMMIT")
  for (const reader of [a, b, cache()]) {
    const result = reader.read(db, args)
    expect(result.rows[0]!.query).toMatchObject({ status: 'partial', relationCount: 1 })
    expect(result.counts).toEqual({ success: 1, partial: 2, failed: 1, no_record: 1 })
  }
})

it('source eviction and same-path replacement isolate identical IDs and close old readers', () => {
  const first = fixture(), second = fixture(), third = fixture(), args = { view: 'summary' as const }
  second.$client.exec("UPDATE platform_query SET status='partial' WHERE id=5")
  third.$client.exec("UPDATE platform_query SET status='no_record' WHERE id=5")
  const reader = cache({ maxSources: 2 })
  expect(reader.read(first, args).rows[0]!.query.status).toBe('not_queried')
  expect(reader.read(second, args).rows[0]!.query.status).toBe('partial')
  expect(reader.read(third, args).rows[0]!.query.status).toBe('no_record')
  expect(reader.stats()).toMatchObject({ sources: 2, entries: 2 })
  expect(reader.read(first, args).rows[0]!.query.status).toBe('not_queried')
  // Replacement is a closed, checkpointed DB; never replace an active writer's database in deployment.
  first.$client.pragma('wal_checkpoint(TRUNCATE)')
  second.$client.pragma('wal_checkpoint(TRUNCATE)'); second.$client.close()
  renameSync(second.$client.name, first.$client.name)
  expect(reader.read(first, args).rows[0]!.query.status).toBe('partial')
  expect(reader.stats().sources).toBeLessThanOrEqual(2)
  reader.close()
  expect(reader.stats()).toMatchObject({ sources: 0, entries: 0, bytes: 0 })
})

it('read errors are not cached as empty and recovered schema reads refill normally', () => {
  const db = fixture(), reader = cache(), args = { view: 'summary' as const }
  const expected = reader.read(db, args)
  db.$client.exec('ALTER TABLE platform_query RENAME TO temporarily_unavailable')
  expect(() => reader.read(db, args)).toThrow()
  expect(() => reader.read(db, args)).toThrow()
  expect(reader.stats()).toMatchObject({ entries: 0, bytes: 0 })
  db.$client.exec('ALTER TABLE temporarily_unavailable RENAME TO platform_query')
  expect(reader.read(db, args)).toEqual(expected)
  expect(reader.read(db, args)).toEqual(expected)
  expect(reader.stats().hits).toBe(1)
})

it('synchronous burst has one miss and bounded churn releases every retained entry', async () => {
  const db = fixture(), reader = cache({ maxBytes: 4000, maxEntries: 2 }), args = { view: 'summary' as const, pageSize: 1 }
  const burst = await Promise.all(Array.from({ length: 100 }, async () => reader.read(db, args)))
  for (const result of burst) expect(result.rows.map(row => row.query.id)).toEqual([5])
  expect(reader.stats()).toMatchObject({ hits: 99, misses: 1, entries: 1 })
  for (let n = 0; n < 1000; n++) {
    reader.read(db, { ...args, pageSize: 1 + n % 50 })
    expect(reader.stats().bytes).toBeLessThanOrEqual(4000)
    expect(reader.stats().entries).toBeLessThanOrEqual(2)
  }
  reader.close()
  expect(reader.stats()).toMatchObject({ sources: 0, entries: 0, bytes: 0 })
})

it('invalid or increased capacity options fail before any database opens', () => {
  for (const options of [{ maxBytes: 0 }, { maxEntries: 0 }, { ttlMs: 0 }, { maxSources: 0 }, { maxEntryBytes: -1 }, { ttlMs: Infinity }, { maxEntries: 129 }, { ttlMs: 5001 }]) {
    expect(() => createPlatformSummaryCache(options)).toThrow(RangeError)
  }
})

it('explicit undefined limits use the bounded defaults', () => {
  const db = fixture(), reader = cache({ maxBytes: undefined, maxEntries: undefined })
  reader.read(db, { view: 'summary' })
  expect(reader.stats()).toMatchObject({ entries: 1, misses: 1 })
})
