import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { listPlatformQueries } from '../lib/platform/read'

it('upgrades an archived SQLite database without changing evidence, IDs, audit or uniqueness and removes proven scan/sort hotspots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-index-migration-'))
  const sqlite = new Database(join(dir, 'test.sqlite'))
  try {
    sqlite.pragma('foreign_keys = ON')
    const folder = resolve('db/migrations')
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
    const oldFolder = join(dir, 'old')
    // Exercise a real pre-#87 database, rather than only bootstrapping the latest schema.
    mkdirSync(join(oldFolder, 'meta'), { recursive: true })
    const oldJournal = { ...journal, entries: journal.entries.filter((e: { idx: number }) => e.idx <= 12) }
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(oldJournal))
    for (const entry of oldJournal.entries) copyFileSync(join(folder, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`))
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: oldFolder })
    db.insert(schema.title).values({ code: 'specialized_sme', nameZh: '专精特新', level: 'municipal', rank: 2 }).run()
    const enterprise = db.insert(schema.enterprise).values({ name: '合成企业', nameNorm: '合成企业' }).returning().get()
    const batch = db.insert(schema.importBatch).values({ idempotencyKey: 'synthetic:replay', sourceKind: 'platform_export', sourceIdentity: 'synthetic' }).returning().get()
    // The archived fixture predates last_collected_at and relation title_raw.
    const ids = (['success', 'partial', 'failed', 'no_record', 'not_queried'] as const).map((status, n) => Number(sqlite.prepare(
      'insert into platform_query(interface,query_key,queried_at,status,raw_response,collection_evidence,created_at) values(?,?,?,?,?,?,?)',
    ).run('recognized_list', `synthetic:${n}`, '2026-10-19', status, '原档🙂', JSON.stringify({ titleScope: { rdjb: ['2'] }, pages: [] }), '2026-10-19').lastInsertRowid))
    for (const sequenceNo of [2, 1]) sqlite.prepare('insert into platform_relation(query_id,sequence_no,enterprise_id,uscc_raw,relation_key,raw_fields,created_at) values(?,?,?,?,?,?,?)')
      .run(ids[0]!, sequenceNo, enterprise.id, 'synthetic:uscc', 'duplicate', JSON.stringify({ original: `原行${sequenceNo}🙂` }), '2026-10-19')
    const proof = db.insert(schema.comparisonScopeProof).values({ kind: 'official_coverage', evidence: { original: '不可变审计🙂' }, sourceFingerprint: 'synthetic:fingerprint', createdAt: '2026-10-19' }).returning().get()
    db.insert(schema.comparisonScopeProofAudit).values({ proofId: proof.id, batchId: batch.id, idempotencyKey: 'synthetic:replay', toStatus: 'candidate', expectedRevision: 0, resultingRevision: 1, actorType: 'agent', actorId: 'synthetic', basis: 'fixture', ruleId: 'fixture', ruleVersion: '1', decidedAt: '2026-10-19' }).run()
    const edge = db.insert(schema.recordCorrespondence).values({ edgeKey: 'synthetic:edge', type: 'recognized_export', role: 'context', titleCode: 'specialized_sme', status: 'candidate', revision: 1, targetIdentity: {}, provenance: { original: '原始出处🙂' }, sourceFingerprint: 'synthetic:edge', ruleId: 'fixture', ruleVersion: '1', createdAt: '2026-10-19' }).returning().get()
    db.insert(schema.recordCorrespondenceAudit).values({ correspondenceId: edge.id, batchId: batch.id, idempotencyKey: 'synthetic:replay', toStatus: 'candidate', expectedRevision: 0, resultingRevision: 1, actorType: 'agent', actorId: 'synthetic', basis: 'fixture', ruleId: 'fixture', ruleVersion: '1', evidence: { original: '追加审计🙂' }, decidedAt: '2026-10-19' }).run()
    const tables = sqlite.prepare("select name from sqlite_master where type='table' and name not like '__drizzle%' order by name").all() as { name: string }[]
    const baselineColumns = new Map(tables.map(({ name }) => [name, (sqlite.pragma(`table_info('${name}')`) as { name: string }[]).map(column => column.name)]))
    const contents = () => tables.map(({ name }) => [name, sqlite.prepare(`select ${baselineColumns.get(name)!.map(column => `"${column}"`).join(',')} from "${name}" order by rowid`).all()])
    const before = contents()
    const filters = [{ view: 'summary' as const }, { status: 'partial' as const }, { uscc: 'synthetic:uscc' }, { enterpriseId: enterprise.id }, { queryKey: 'synthetic:0', includeRawResponse: true }, { page: 2, pageSize: 2 }]
    // Independent historical SQL oracle: do not call a modern full-row ORM
    // reader against the old schema or fabricate columns to make it readable.
    const queryIds = (where: string, ...params: (string | number)[]) => (sqlite.prepare(`select id from platform_query ${where} order by queried_at desc,id desc`).all(...params) as { id: number }[]).map(row => row.id)
    const expectedIds = [
      queryIds(''), queryIds('where status = ?', 'partial'),
      queryIds('where id in (select query_id from platform_relation where uscc_raw = ?)', 'synthetic:uscc'),
      queryIds('where id in (select query_id from platform_relation where enterprise_id = ?)', enterprise.id),
      queryIds('where query_key = ?', 'synthetic:0'), queryIds('').slice(2, 4),
    ]
    migrate(db, { migrationsFolder: folder })
    const plan = (sql: string) => (sqlite.prepare(`explain query plan ${sql}`).all() as { detail: string }[]).map(r => r.detail).join('\n')
    expect(plan('select status,count(*) from platform_query group by status')).toContain('COVERING INDEX')
    expect(plan('select status,count(*) from platform_query group by status')).not.toContain('TEMP B-TREE')
    expect(plan('select id from platform_query order by queried_at desc,id desc limit 25 offset 3')).not.toContain('TEMP B-TREE')
    expect(plan("select id from platform_query where status='partial' order by queried_at desc,id desc limit 25")).toContain('SEARCH platform_query USING COVERING INDEX')
    expect(plan("select query_id from platform_relation where uscc_raw='synthetic:uscc'")).toContain('SEARCH platform_relation USING COVERING INDEX')
    expect(contents()).toEqual(before)
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    const results = filters.map(f => listPlatformQueries(db, f))
    expect(results.map(result => result.rows.map(row => row.query.id))).toEqual(expectedIds)
    expect(results.map(result => result.total)).toEqual([5, 1, 1, 1, 1, 5])
    expect(results.map(result => result.counts)).toEqual([
      { success: 1, partial: 1, failed: 1, no_record: 1, not_queried: 1 },
      { partial: 1 }, { success: 1 }, { success: 1 }, { success: 1 },
      { success: 1, partial: 1, failed: 1, no_record: 1, not_queried: 1 },
    ])
    expect(results[4]!.rows[0]!.query.rawResponse).toBe('原档🙂')
    expect(results[2]!.rows[0]!.relations.map(row => row.rawFields)).toEqual([{ original: '原行1🙂' }, { original: '原行2🙂' }])
    expect(results[0]!.rows.map(r => r.query.id)).toEqual([...ids].reverse())
    expect(results[2]!.rows[0]!.relations.map(r => r.sequenceNo)).toEqual([1, 2])
    expect(() => sqlite.prepare('insert into platform_query(interface,query_key,rdjb,queried_at,status,created_at) select interface,query_key,rdjb,queried_at,status,created_at from platform_query limit 1').run()).toThrow(/UNIQUE/)
    expect(() => sqlite.prepare('insert into platform_relation(query_id,sequence_no,created_at) values(99999,1,?)').run('synthetic')).toThrow(/FOREIGN KEY/)
    migrate(db, { migrationsFolder: folder })
    expect(contents()).toEqual(before)
    expect(filters.map(filter => listPlatformQueries(db, filter))).toEqual(results)
    // Emergency DDL rollback removes only the new acceleration structures.
    for (const name of ['platform_query_status_time_idx', 'platform_query_time_idx', 'platform_relation_uscc_query_idx']) sqlite.exec(`drop index ${name}`)
    expect(contents()).toEqual(before)
    expect(plan('select status,count(*) from platform_query group by status')).toContain('TEMP B-TREE')
    expect(filters.map(filter => listPlatformQueries(db, filter))).toEqual(results)
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('benchmark refuses an existing output directory before opening or modifying the snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-probe-safety-'))
  const source = join(dir, 'snapshot.sqlite')
  const sqlite = new Database(source)
  sqlite.exec('create table sentinel(value text); insert into sentinel values(\'preserved\')')
  sqlite.close()
  const original = readFileSync(source)
  try {
    const run = spawnSync(process.execPath, ['scripts/bench-sqlite-indexes.mjs', source, dir], { cwd: resolve('.'), encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Output directory must not exist')
    expect(readFileSync(source)).toEqual(original)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('benchmark refuses a live WAL source before creating a destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-probe-wal-'))
  const source = join(dir, 'live.sqlite'), output = join(dir, 'new-output')
  const sqlite = new Database(source)
  try {
    sqlite.pragma('journal_mode=WAL')
    sqlite.exec("create table sentinel(value text); insert into sentinel values('preserved')")
    const original = readFileSync(source + '-wal')
    const run = spawnSync(process.execPath, ['scripts/bench-sqlite-indexes.mjs', source, output], { cwd: resolve('.'), encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Use a frozen checkpointed snapshot')
    expect(existsSync(output)).toBe(false)
    expect(readFileSync(source + '-wal')).toEqual(original)
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }) }
})
