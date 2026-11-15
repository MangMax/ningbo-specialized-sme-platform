import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sql as schemaSql } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { targetSchema } from '../../../lib/platform/target-schema'
import { reserveLegacyIds } from '../../../lib/platform/target-archive'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import type { PlatformRawRow } from '../../../lib/platform/adapter'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import { commitRosterImport } from '../../../server/utils/roster-import'
import { reuseCollectedPlatformResult } from '../../../server/utils/platform-collection-reuse'
import { writeCollectionTarget } from '../../../lib/platform/collection-target-replay'

// Required owner paths prevent accidental writes into historical fixture roots.
const evidenceRoot = process.env.REUSE_761_EVIDENCE_DIR
const shared = process.env.PLATFORM_757_FIXTURES
if (Boolean(evidenceRoot) !== Boolean(shared)) throw new Error('Supply both REUSE_761_EVIDENCE_DIR and PLATFORM_757_FIXTURES')
describe.runIf(Boolean(evidenceRoot && shared))('explicit historical collection reuse source acceptance', () => {
const root = evidenceRoot ? mkdtempSync(join(evidenceRoot, 'reuse761-')) : ''
const schema0 = join(root, 'schema0-baseline.sqlite')
let t: Database.Database, old: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>, oracle: typeof db
let serial = 0, requestId = 0
const trace: string[] = []
const time = '2026-11-13T00:00:00Z', later = '2026-11-13T01:00:00Z'
const sources = ['queryList', 'businessList', 'queryBusList'] as const

beforeAll(() => {
  const base = new Database(schema0)
  migrate(drizzle(base), { migrationsFolder: 'db/migrations' })
  base.exec(`insert into title(code,name_zh,level,rank) values
    ('innovative_sme','创新型中小企业','municipal',1),('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3);
    insert into enterprise(id,name,name_norm,uscc_norm) values(2,'Other','Other','91330200712345678B'),(3,'Reuse','Reuse','91330200712345678A');
    insert into sqlite_sequence(name,seq) values('platform_query',8000),('platform_relation',9000)`)
  base.close()
})
beforeEach(() => {
  const targetPath = join(root, `target-${++serial}.sqlite`), oldPath = join(root, `old-${serial}.sqlite`)
  copyFileSync(join(shared!, 'absent-71613.sqlite'), targetPath)
  chmodSync(targetPath, 0o600)
  copyFileSync(schema0, oldPath)
  t = new Database(targetPath, { verbose: q => trace.push(String(q)) }); t.pragma('foreign_keys=ON')
  old = new Database(oldPath); old.pragma('foreign_keys=ON')
  t.exec("insert into enterprise(id,name,name_norm,uscc_norm) values(3,'Reuse','Reuse','91330200712345678A')")
  db = drizzle(t, { schema }); oracle = drizzle(old, { schema })
  reserveLegacyIds(drizzle(t, { schema: targetSchema }), { query: 8000, relation: 9000 })
  trace.length = 0
})
afterEach(() => {
  // Inspect the actual connection, including admission, equality and savepoint SQL.
  expect(trace.filter(q => /\b(?:from|join|into|update|delete from)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$|\()/i.test(q))).toEqual([])
  expect(t.pragma('foreign_key_check')).toEqual([])
  writeFileSync(join(root, `trace-${serial}.json`), JSON.stringify(trace))
  old.close(); t.close()
})
function collection(source: PlatformLiveQueryResult['source'] = 'businessList', rows?: PlatformRawRow[]): PlatformLiveQueryResult {
  const raw = rows ?? ['REUSE-A', 'REUSE-B'].map(id => ({ id, rdjb: '2', qymc: 'Reuse', tyshxydm: '91330200712345678A', sblx: '申请',
    cszt: '终审通过', year: '2024', extra: { null: null, list: [false, 17, '尾😀'] }, empty: null }))
  return { source, status: raw.length ? 'success' : 'no_record', effectiveConditions: { uscc: '91330200712345678A', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: ['2'] },
    queriedAt: time, completedAt: time,
    rows: raw.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]))),
    dataRows: raw, pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, fetchedCount: raw.length, declaredTotal: raw.length, status: 'success', error: null }],
    fetchedCount: raw.length, declaredTotal: raw.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 } }
}
function imported(result: PlatformLiveQueryResult, both = true) {
  const input = { idempotencyKey: `761:${++requestId}`, sourceKind: 'platform_archive' as const, sourceIdentity: 'reuse761',
    payload: { platformQueries: [platformResultToImport(result)] } }
  const actual = commitRosterImport(db, input, [], { deferCandidateTasks: true })
  expect(actual.status).toBe('committed')
  if (both) {
    const expected = commitRosterImport(oracle, input, [], { deferCandidateTasks: true })
    expect(expected.status).toBe('committed')
    expect(actual.summary).toEqual(expected.summary)
  }
  return input
}
function reuse(result: PlatformLiveQueryResult, owner = 3) {
  result = { ...result, completedAt: '2026-11-16T00:00:00Z' }
  const actual = reuseCollectedPlatformResult(db, result, owner)
  expect(actual).toBe(reuseCollectedPlatformResult(oracle, result, owner))
  return actual
}
function recency() {
  return t.prepare('select id,queried_at,last_collected_at from platform_collection where id>13 order by id').all()
}
function immutable() {
  const tables = ['platform_collection_page', 'platform_collection_condition', 'platform_query_title_scope',
    'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_observation_assignment',
    'platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection',
    'platform_legacy_query_alias', 'platform_legacy_relation_alias', 'platform_legacy_alias_sequence',
    'platform_archive_value', 'platform_collection_archive_ref', 'platform_observation_archive_ref', 'platform_version_archive_ref',
    'platform_observation_fingerprint_basis', 'platform_collection_legacy_provenance',
    'import_receipt', 'import_batch', 'evidence_revision_113']
  const collections = t.prepare('select * from platform_collection order by id').all().map(row => {
    if (!row || typeof row !== 'object') throw new Error('Expected collection row')
    return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'last_collected_at'))
  })
  return [['platform_collection_except_recency', collections], ...tables.map(table => [table, t.prepare(`select * from ${table} order by rowid`).raw().all()])]
}
it.each(sources)('reuses %s equal and reordered raw content with literal IDs counts bytes and independent schema0 oracle', source => {
  const first = collection(source); imported(first)
  expect(t.prepare('select old_id,collection_id from platform_legacy_query_alias where old_id>8000').all()).toEqual([{ old_id: 8001, collection_id: 14 }])
  expect(t.prepare('select old_id,observation_id from platform_legacy_relation_alias where old_id>9000 order by old_id').all()).toEqual([{ old_id: 9001, observation_id: 9 }, { old_id: 9002, observation_id: 10 }])
  expect(t.prepare('select count(*) n from platform_business_observation where collection_id=14').get()).toEqual({ n: 2 })
  const expectedBytes = Buffer.from(JSON.stringify(first))
  expect(t.prepare(`select v.bytes,v.byte_length,v.sha256 from platform_collection_archive_ref r
    join platform_archive_value v on v.id=r.archive_id where r.owner_id=14 and r.field='collectionEvidence'`).get()).toEqual({
    bytes: expectedBytes, byte_length: expectedBytes.length, sha256: createHash('sha256').update(expectedBytes).digest('hex'),
  })
  const frozen = immutable()
  const repeat = { ...first, queriedAt: later, completedAt: later }
  expect(reuse(repeat)).toBe(true)
  expect(recency()).toEqual([{ id: 14, queried_at: time, last_collected_at: later }])
  expect(old.prepare('select id,queried_at,last_collected_at from platform_query').get()).toEqual({ id: 8001, queried_at: time, last_collected_at: later })
  const reordered = { ...repeat, dataRows: first.dataRows!.toReversed(), rows: first.rows.toReversed() }
  expect(reuse(reordered)).toBe(true)
  expect(immutable()).toEqual(frozen)
  const changed = collection(source, [{ ...first.dataRows![0]!, empty: false }, first.dataRows![1]!])
  expect(reuse(changed)).toBe(false)
  expect(immutable()).toEqual(frozen)
  // Exact command replay is a distinct operation and cannot advance recency.
  const q = platformResultToImport(first)
  expect(writeCollectionTarget(drizzle(t, { schema: targetSchema }), { queryText: JSON.stringify(q), evidenceText: JSON.stringify(q.collectionEvidence),
    createdAt: 'unused', assignments: [] }).reused).toBe(true)
  expect(recency()).toEqual([{ id: 14, queried_at: time, last_collected_at: later }])
  expect(immutable()).toEqual(frozen)
})
it.each(sources)('reuses %s complete empty no_record without observations', source => {
  const empty = collection(source, []); imported(empty)
  const frozen = immutable()
  expect(reuse({ ...empty, queriedAt: later })).toBe(true)
  expect(t.prepare('select count(*) n from platform_business_observation where collection_id=14').get()).toEqual({ n: 0 })
  expect(recency()).toEqual([{ id: 14, queried_at: time, last_collected_at: later }])
  expect(immutable()).toEqual(frozen)
})
it.each(sources)('does not skip the latest partial %s collection for an older complete one', source => {
  const first = collection(source); imported(first)
  const partial = collection(source, [first.dataRows![0]!])
  partial.queriedAt = later; partial.completedAt = later; partial.status = 'partial'; partial.completeness = 'partial'; partial.limits.pageSize = 1
  partial.declaredTotal = 2; partial.pages[0]!.declaredTotal = 2; partial.pages[0]!.maxPage = 2
  partial.unfinished = [{ source, rdjb: source === 'queryList' ? null : '2', page: 2 }]
  partial.error = { code: 'safety_limit', message: 'stopped' }
  imported(partial)
  const frozen = immutable(), times = recency()
  expect(reuse({ ...first, queriedAt: '2026-11-13T02:00:00Z' })).toBe(false)
  expect(reuse(partial)).toBe(false)
  expect(recency()).toEqual(times); expect(immutable()).toEqual(frozen)
})
it('keeps exact query conditions rdjb and title scope separate', () => {
  const apply = collection('queryList'); imported(apply)
  expect(reuse({ ...apply, effectiveConditions: { ...apply.effectiveConditions, name: 'different' } })).toBe(false)
  const first = collection(); imported(first)
  const otherScope = collection('businessList', [])
  otherScope.titleScope.rdjb = ['3']; otherScope.pages[0]!.rdjb = '3'
  expect(reuse(otherScope)).toBe(false)
  // Same interface/key/rdjb but a distinct explicit titleCode must not be reused.
  const q = platformResultToImport(first)
  corruptible(t, 'platform_collection')
  t.prepare("update platform_collection set title_code=null where id=15").run()
  old.prepare('update platform_query set title_code=null where id=8002').run()
  expect(q.titleCode).toBe('specialized_sme')
  expect(reuse(first)).toBe(false)
})
it.each(sources)('uses current revision2 %s ownership without requiring confirmation', source => {
  const first = collection(source); imported(first)
  for (const owner of [2, 3]) {
    t.prepare(`insert into platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin,basis)
      values(9,?,?,'manual','pending','command','761 revision')`).run(owner === 2 ? 2 : 3, owner)
    old.prepare("update platform_relation set enterprise_id=?,verification_status='pending' where id=9001").run(owner)
    expect(reuse(first)).toBe(owner === 3)
  }
})
it.each(sources)('misses %s missing version projection coverage', source => {
  const first = collection(source); imported(first)
  const table = { queryList: 'platform_apply_projection', businessList: 'platform_business_projection', queryBusList: 'platform_recognized_projection' }[source]
  corruptible(t, table)
  t.exec(`delete from ${table} where version_id in(select version_id from platform_business_observation where collection_id=14)`)
  old.exec(`delete from ${table}`)
  const frozen = immutable()
  expect(reuse(first)).toBe(false); expect(immutable()).toEqual(frozen)
})
it('preserves JS time comparison for null same earlier invalid and timezone-equivalent recency', () => {
  const first = collection(); imported(first)
  t.exec('update platform_collection set last_collected_at=null where id=14')
  old.exec('update platform_query set last_collected_at=null where id=8001')
  for (const queriedAt of [time, '2026-11-12T00:00:00Z', '2026-11-13T08:00:00+08:00']) {
    expect(reuse({ ...first, queriedAt })).toBe(true)
    expect(recency()).toEqual([{ id: 14, queried_at: time, last_collected_at: null }])
  }
  for (const database of [db, oracle]) expect(() => reuseCollectedPlatformResult(database, { ...first, queriedAt: 'invalid' }, 3)).toThrow('Original queriedAt/completedAt')
  expect(reuse({ ...first, queriedAt: later })).toBe(true)
  for (const value of ['invalid', '']) {
    t.prepare('update platform_collection set last_collected_at=? where id=14').run(value)
    old.prepare('update platform_query set last_collected_at=? where id=8001').run(value)
    expect(reuse({ ...first, queriedAt: '2026-11-14T00:00:00Z' })).toBe(true)
    expect(recency()).toEqual([{ id: 14, queried_at: time, last_collected_at: value }])
  }
})
it('rolls recency and caller checkpoint back through the same nested transaction then retries', () => {
  const first = collection(); imported(first)
  for (const connection of [t, old]) connection.exec("create table checkpoint761(value text); insert into checkpoint761 values('before')")
  const frozen = immutable()
  for (const database of [db, oracle]) {
    expect(() => database.transaction(tx => {
      expect(reuseCollectedPlatformResult(tx, { ...first, queriedAt: later, completedAt: later }, 3)).toBe(true)
      // The target update occurs before the injected caller failure.
      tx.run(schemaSql`update checkpoint761 set value='after'`)
      throw new Error('761 post-update failure')
    })).toThrow('761 post-update failure')
  }
  expect(recency()).toEqual([{ id: 14, queried_at: time, last_collected_at: null }])
  expect(t.prepare('select value from checkpoint761').get()).toEqual({ value: 'before' })
  expect(old.prepare('select value from checkpoint761').get()).toEqual({ value: 'before' })
  expect(reuse({ ...first, queriedAt: later })).toBe(true)
  expect(immutable()).toEqual(frozen)
})
it.each(sources)('does not skip latest changed complete %s content', source => {
  const first = collection(source); imported(first)
  const changed = collection(source, [{ ...first.dataRows![0]!, extra: 'changed' }, first.dataRows![1]!])
  changed.queriedAt = later; changed.completedAt = later
  imported(changed)
  const frozen = immutable(), times = recency()
  expect(reuse({ ...first, queriedAt: '2026-11-13T02:00:00Z' })).toBe(false)
  expect(recency()).toEqual(times); expect(immutable()).toEqual(frozen)
})
it('misses recognized original row equality when historical typed raw capture is absent', () => {
  const first = collection('queryBusList')
  delete first.dataRows
  imported(first)
  expect(reuse({ ...collection('queryBusList'), queriedAt: later })).toBe(false)
})
it.each(['queryList', 'businessList'] as const)('retains %s import rejection when typed raw capture is absent', source => {
  const first = collection(source); delete first.dataRows
  expect(() => platformResultToImport(first)).toThrow('requires typed business dataRows')
  expect(reuseCollectedPlatformResult(db, first, 3)).toBe(false)
})
it.each(['conditions', 'scope', 'page', 'unknown', 'fullRange', 'completeness', 'status'] as const)('rejects structured %s facts before reading immutable content', fact => {
  const first = collection(); imported(first)
  const table = fact === 'conditions' ? 'platform_collection_condition' : fact === 'scope' ? 'platform_query_title_scope'
    : fact === 'page' ? 'platform_collection_page' : 'platform_collection'
  corruptible(t, table)
  if (fact === 'conditions') t.exec("update platform_collection_condition set text_value='other' where collection_id=14 and name='uscc'")
  if (fact === 'scope') t.exec("delete from platform_query_title_scope where collection_id=14")
  if (fact === 'page') t.exec("update platform_collection_page set page_no=2 where collection_id=14")
  if (fact === 'unknown') t.exec("update platform_collection set parse_state='absent' where id=14")
  if (fact === 'fullRange') t.exec("update platform_collection set full_range=0 where id=14")
  if (fact === 'completeness') t.exec("update platform_collection set completeness='unknown' where id=14")
  if (fact === 'status') t.exec("update platform_collection set status='failed' where id=14")
  trace.length = 0
  expect(reuseCollectedPlatformResult(db, first, 3)).toBe(false)
  expect(trace.filter(q => /\bplatform_archive_value\b/.test(q))).toEqual([])
})
it.each(['missing', 'hash'] as const)('misses %s sealed equality evidence without writes or reconstruction', damage => {
  const first = collection(); imported(first)
  if (damage === 'missing') {
    corruptible(t, 'platform_collection_archive_ref')
    t.exec("delete from platform_collection_archive_ref where owner_id=14 and field='collectionEvidence'")
  } else {
    corruptible(t, 'platform_archive_value')
    t.prepare("update platform_archive_value set sha256=? where id=(select archive_id from platform_collection_archive_ref where owner_id=14 and field='collectionEvidence')").run('0'.repeat(64))
  }
  const frozen = immutable(), times = recency()
  expect(reuseCollectedPlatformResult(db, { ...first, queriedAt: later, completedAt: later }, 3)).toBe(false)
  expect(immutable()).toEqual(frozen); expect(recency()).toEqual(times)
})
it('breaks equal-time ties by public query alias rather than physical collection ID', () => {
  const first = collection(); imported(first)
  const changed = collection('businessList', [{ ...first.dataRows![0]!, extra: 'changed' }, first.dataRows![1]!])
  changed.queriedAt = later; changed.completedAt = later; imported(changed)
  // Normal identity uniqueness prevents this tie. This isolated adversarial
  // fixture relaxes it to test the required historical alias ordering directly.
  corruptible(t, 'platform_collection'); corruptible(t, 'platform_legacy_query_alias')
  t.exec("drop index platform_collection_identity_uq; update platform_collection set queried_at='2026-11-13T00:00:00Z' where id=15")
  expect(reuseCollectedPlatformResult(db, first, 3)).toBe(false)
  t.exec('update platform_legacy_query_alias set old_id=8100 where collection_id=14')
  expect(reuseCollectedPlatformResult(db, first, 3)).toBe(true)
  expect(t.prepare('select old_id,collection_id from platform_legacy_query_alias where old_id>8000 order by old_id').all()).toEqual([
    { old_id: 8002, collection_id: 15 }, { old_id: 8100, collection_id: 14 },
  ])
})
/** Deliberate damaged-target cases only; never an application repair path. */
function corruptible(connection: Database.Database, table: string) {
  const triggers = connection.prepare<[string], { name: string }>("select name from sqlite_master where type='trigger' and tbl_name=?").all(table)
  for (const row of triggers) {
    connection.exec(`drop trigger "${row.name.replaceAll('"', '""')}"`)
  }
}

})
