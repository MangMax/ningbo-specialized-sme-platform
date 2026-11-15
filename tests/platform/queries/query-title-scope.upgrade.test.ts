import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../../../upgrade/legacy-schema'
import { readMigratedTitleScope as listPlatformQueries } from './oracles/legacy-title-scope'

it('keeps title scope history and status counts while avoiding an archive scan for summary pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-title-scope-'))
  const sqlite = new Database(join(dir, 'roster.sqlite'))
  try {
    sqlite.pragma('foreign_keys = ON')
    const folder = resolve('db/migrations')
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
    const oldFolder = join(dir, 'before-83')
    mkdirSync(join(oldFolder, 'meta'), { recursive: true })
    const oldJournal = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 24) }
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(oldJournal))
    for (const entry of oldJournal.entries) copyFileSync(join(folder, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`))
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: oldFolder })
    for (const [code, rank] of [['innovative_sme', 1], ['specialized_sme', 2], ['little_giant', 3]] as const) {
      db.insert(schema.title).values({ code, nameZh: code, level: 'municipal', rank }).run()
    }
    const insert = (key: string, titleCode: string | null, scope: string[] | null, status: 'success' | 'partial' | 'failed' = 'success') =>
      // Explicit legacy columns work both before and after additive migrations.
      Number(sqlite.prepare('INSERT INTO platform_query(interface,query_key,queried_at,status,title_code,collection_evidence,created_at) VALUES(?,?,?,?,?,?,?)').run(
        'recognized_list', key, `2026-10-19T00:00:0${key.length}Z`, status, titleCode,
        scope ? JSON.stringify({ titleScope: { rdjb: scope }, rows: [{ archived: '原档🙂' }] }) : null, '2026-10-19',
      ).lastInsertRowid)
    const direct = insert('direct', 'specialized_sme', ['2'])
    const multi = insert('multi', null, ['1', '2'], 'partial')
    const other = insert('other', 'little_giant', ['3'])
    const mixed = insert('mixed', 'specialized_sme', ['3'], 'failed')
    const duplicate = insert('duplicate', null, ['2', '2'])
    insert('none', null, null)
    const filters = [{ titleCode: 'specialized_sme', view: 'summary' as const }, { titleCode: 'little_giant', view: 'summary' as const }, { titleCode: 'specialized_sme', status: 'partial' as const, view: 'summary' as const }]
    migrate(db, { migrationsFolder: folder })
    const prepared: string[] = []
    const originalPrepare = sqlite.prepare.bind(sqlite)
    sqlite.prepare = ((statement: string) => {
      if (/^select\s/i.test(statement) && statement.includes('platform_query')) prepared.push(statement)
      return originalPrepare(statement)
    }) as typeof sqlite.prepare
    try {
      const results = filters.map(filter => listPlatformQueries(db, filter))
      expect(results[0]!.rows.map(row => row.query.id)).toEqual([duplicate, direct, mixed, multi])
      expect(results[0]!.counts).toEqual({ success: 2, failed: 1, partial: 1 })
      expect(results[1]!.rows.map(row => row.query.id)).toEqual([mixed, other])
      expect(results[2]!.rows.map(row => row.query.id)).toEqual([multi])
      expect(results[2]!.counts).toEqual({ partial: 1 })
    } finally { sqlite.prepare = originalPrepare as typeof sqlite.prepare }
    const plans = prepared.filter(statement => /group by|order by/i.test(statement)).map(statement =>
      (originalPrepare(`explain query plan ${statement}`).all(...Array((statement.match(/\?/g) ?? []).length).fill(null)) as { detail: string }[]).map(row => row.detail).join('\n'))
    expect(plans).toHaveLength(6)
    for (const [index, plan] of plans.entries()) {
      expect(plan).toMatch(index % 2 === 0
        ? /(?:SCAN|SEARCH) platform_query USING COVERING INDEX platform_query_status_time_idx/
        : index === 5
          ? /(?:SCAN|SEARCH) platform_query USING COVERING INDEX platform_query_status_time_idx/
          : /(?:SCAN|SEARCH) platform_query USING COVERING INDEX platform_query_time_idx/)
      expect(plan).not.toContain('SCAN json_each')
    }
    const insertedAfterMigration = insert('post', null, ['2'])
    expect(listPlatformQueries(db, { queryId: insertedAfterMigration, titleCode: 'specialized_sme', view: 'summary' }).rows.map(row => row.query.id)).toEqual([insertedAfterMigration])
    sqlite.prepare('delete from platform_query where id = ?').run(insertedAfterMigration)
    expect(sqlite.prepare('select count(*) n from platform_query_title_scope where query_id = ?').get(insertedAfterMigration)).toEqual({ n: 0 })
    sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run(JSON.stringify({ titleScope: { rdjb: ['3'] } }), multi)
    expect(listPlatformQueries(db, filters[0]!).rows.map(row => row.query.id)).toEqual([duplicate, direct, mixed])
    expect(listPlatformQueries(db, filters[1]!).rows.map(row => row.query.id)).toEqual([mixed, other, multi])
    sqlite.prepare('delete from platform_query where id = ?').run(duplicate)
    expect(listPlatformQueries(db, filters[0]!).rows.map(row => row.query.id)).toEqual([direct, mixed])
    // Invalid unrelated archive text must not turn an existing direct-title row into an ingestion failure.
    sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run('{invalid historic archive', direct)
    expect(listPlatformQueries(db, filters[0]!).rows.map(row => row.query.id)).toEqual([direct, mixed])
    sqlite.exec('begin immediate')
    try {
      sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run('{rolled back archive', multi)
      expect(() => listPlatformQueries(db, { queryId: multi, titleCode: 'specialized_sme', view: 'summary' })).toThrow('malformed JSON')
    } finally { sqlite.exec('rollback') }
    expect(listPlatformQueries(db, { queryId: multi, titleCode: 'little_giant', view: 'summary' }).rows.map(row => row.query.id)).toEqual([multi])
    expect(listPlatformQueries(db, { queryId: multi, titleCode: 'specialized_sme', view: 'summary' }).rows).toEqual([])
    const malformedInsert = Number(sqlite.prepare(`insert into platform_query(interface,query_key,queried_at,status,collection_evidence,created_at)
      values ('recognized_list','post-malformed','2026-10-20','partial','{invalid inserted JSON','2026-10-20')`).run().lastInsertRowid)
    const malformedFilter = { queryId: malformedInsert, titleCode: 'specialized_sme', view: 'summary' as const }
    expect(() => listPlatformQueries(db, malformedFilter)).toThrow('malformed JSON')
    sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run(JSON.stringify({ titleScope: { rdjb: ['2'] } }), malformedInsert)
    expect(listPlatformQueries(db, malformedFilter).rows.map(row => row.query.id)).toEqual([malformedInsert])
    sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run('{invalid again', malformedInsert)
    sqlite.prepare('delete from platform_query where id = ?').run(malformedInsert)
    expect(listPlatformQueries(db, malformedFilter).rows).toEqual([])
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('matches the original title predicate for NULL, scalar, object, array and malformed archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-title-shapes-'))
  const sqlite = new Database(join(dir, 'roster.sqlite'))
  try {
    sqlite.pragma('foreign_keys = ON')
    const folder = resolve('db/migrations')
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
    const oldFolder = join(dir, 'before-83')
    mkdirSync(join(oldFolder, 'meta'), { recursive: true })
    const oldJournal = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 24) }
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(oldJournal))
    for (const entry of oldJournal.entries) copyFileSync(join(folder, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`))
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: oldFolder })
    db.insert(schema.title).values({ code: 'specialized_sme', nameZh: '合成称号', level: 'municipal', rank: 2 }).run()
    const legacy = sqlite.prepare(`select id from platform_query where query_key = ? and
      (title_code = ? or exists (select 1 from json_each(json_extract(collection_evidence, '$.titleScope.rdjb')) where value = ?))`)
    const cases: Array<[string, string | null, string | null]> = [
      ['sql-null', null, null],
      ['json-null', JSON.stringify({ titleScope: { rdjb: null } }), null],
      ['missing-scope', JSON.stringify({ rows: [] }), null],
      ['boolean', JSON.stringify({ titleScope: { rdjb: true } }), null],
      ['number', JSON.stringify({ titleScope: { rdjb: 2 } }), null],
      ['scalar-digit', JSON.stringify({ titleScope: { rdjb: '2' } }), null],
      ['scalar-json-array', JSON.stringify({ titleScope: { rdjb: '["2"]' } }), null],
      ['scalar-json-text', JSON.stringify({ titleScope: { rdjb: '"2"' } }), null],
      ['object', JSON.stringify({ titleScope: { rdjb: { original: '2' } } }), null],
      ['array', JSON.stringify({ titleScope: { rdjb: ['1', '2'] } }), null],
      ['mixed-types', JSON.stringify({ titleScope: { rdjb: [2, true, null, { nested: '2' }, ['2']] } }), null],
      ['json5-array', "{titleScope:{rdjb:['2',],}, /* legacy */}", null],
      ['json5-second-parse', JSON.stringify({ titleScope: { rdjb: "['2',]" } }), null],
      ['json5-object', "{titleScope:{rdjb:{original:'2'}}}", null],
      ['json5-no-match', "{titleScope:{rdjb:['3']}}", null],
      ['malformed-json', '{invalid archived JSON', null],
      ['malformed-scalar', JSON.stringify({ titleScope: { rdjb: 'not-json' } }), null],
      ['direct-malformed', '{invalid archived JSON', 'specialized_sme'],
    ]
    const expected = [] as Array<{ key: string; originalIds?: number[]; originalError?: string }>
    for (const [key, archived, titleCode] of cases) {
      const id = Number(sqlite.prepare('INSERT INTO platform_query(interface,query_key,queried_at,status,title_code,created_at) VALUES(?,?,?,?,?,?)').run('recognized_list', key, '2026-10-19', 'partial', titleCode, '2026-10-19').lastInsertRowid)
      sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run(archived, id)
      let originalIds: number[] | undefined
      let originalError: string | undefined
      try { originalIds = (legacy.all(key, 'specialized_sme', '2') as { id: number }[]).map(row => row.id) }
      catch (error) { originalError = (error as Error).message }
      expected.push({ key, originalIds, originalError })
    }
    migrate(db, { migrationsFolder: folder })
    for (const { key, originalIds, originalError } of expected) {
      const read = () => listPlatformQueries(db, { queryKey: key, titleCode: 'specialized_sme', view: 'summary' })
      if (originalError) expect(read, key).toThrow(originalError)
      else {
        const result = read()
        expect(result.rows.map(row => row.query.id), key).toEqual(originalIds)
        expect(result.total, key).toBe(originalIds!.length)
        expect(result.counts, key).toEqual(originalIds!.length ? { partial: 1 } : {})
      }
    }
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }) }
})


it('maintains readable JSON5 through writes and rollback without masking a later malformed archive', () => {
  const sqlite = new Database(':memory:')
  try {
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: resolve('db/migrations') })
    sqlite.pragma('foreign_keys = ON')
    const insert = (key: string, archive: string, status = 'partial') => Number(sqlite.prepare(`insert into platform_query(interface, query_key, queried_at, status, collection_evidence, rdjb, created_at)
      values ('recognized_list', ?, '2026-10-20', ?, ?, ?, '2026-10-20')`).run(key, status, archive, status).lastInsertRowid)
    const legacyIds = (key: string) => (sqlite.prepare(`select id from platform_query where query_key = ? and
      (title_code = 'specialized_sme' or exists (select 1 from json_each(json_extract(collection_evidence, '$.titleScope.rdjb')) where value = '2')) order by queried_at desc, id desc`).all(key) as { id: number }[]).map(row => row.id)
    const filter = { titleCode: 'specialized_sme', view: 'summary' as const }
    const first = insert('json5', "{titleScope:{rdjb:['2',]},}")
    const second = insert('json5', JSON.stringify({ titleScope: { rdjb: "['2',]" } }), 'success')
    expect(listPlatformQueries(db, { ...filter, queryKey: 'json5' }).rows.map(row => row.query.id)).toEqual(legacyIds('json5'))
    expect(listPlatformQueries(db, { ...filter, queryKey: 'json5', pageSize: 1 })).toMatchObject({ total: 2, counts: { partial: 1, success: 1 }, rows: [{ query: { id: second } }] })
    expect(listPlatformQueries(db, { ...filter, queryKey: 'json5', status: 'partial' }).rows.map(row => row.query.id)).toEqual([first])
    sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run("{titleScope:{rdjb:['3']}}", first)
    expect(listPlatformQueries(db, { ...filter, queryKey: 'json5' }).rows.map(row => row.query.id)).toEqual([second])
    sqlite.exec('begin')
    sqlite.prepare('update platform_query set collection_evidence = ? where id = ?').run("{titleScope:{rdjb:['2']}}", first)
    expect(listPlatformQueries(db, { ...filter, queryId: first }).total).toBe(1)
    sqlite.exec('rollback')
    expect(listPlatformQueries(db, { ...filter, queryId: first }).total).toBe(0)
    const broken = insert('broken', '{actually malformed')
    expect(() => listPlatformQueries(db, filter)).toThrow('malformed JSON')
    expect(() => legacyIds('broken')).toThrow('malformed JSON')
    sqlite.prepare('delete from platform_query where id = ?').run(broken)
    sqlite.prepare('delete from platform_query where id = ?').run(second)
    expect(listPlatformQueries(db, filter).total).toBe(0)
    expect(sqlite.prepare('select * from platform_query_title_scope_error').all()).toEqual([])
    expect(sqlite.prepare('select * from platform_query_title_scope').all()).toEqual([{ query_id: first, rdjb: '3', collection_id: null }])
  } finally { sqlite.close() }
})


it('does not let a readable JSON5 archive hide a later genuinely malformed archive', () => {
  const sqlite = new Database(':memory:')
  try {
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: resolve('db/migrations') })
    const insert = sqlite.prepare(`insert into platform_query(interface, query_key, queried_at, collection_evidence, created_at) values ('recognized_list', ?, '2026-10-20', ?, '2026-10-20')`)
    insert.run('readable-first', "{titleScope:{rdjb:['2']}}")
    insert.run('broken-second', '{actually malformed')
    expect(() => listPlatformQueries(db, { titleCode: 'specialized_sme', view: 'summary' })).toThrow('malformed JSON')
    expect(listPlatformQueries(db, { queryKey: 'readable-first', titleCode: 'specialized_sme', view: 'summary' }).total).toBe(1)
  } finally { sqlite.close() }
})
