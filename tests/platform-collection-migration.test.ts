import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'

const folder = resolve('db/migrations')
const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
function oldMigrations(root: string) {
  const dest = join(root, 'old')
  mkdirSync(join(dest, 'meta'), { recursive: true })
  const entries = journal.entries.filter((e: { idx: number }) => e.idx <= 46)
  writeFileSync(join(dest, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const e of entries) copyFileSync(join(folder, `${e.tag}.sql`), join(dest, `${e.tag}.sql`))
  return dest
}
function catalog(s: Database.Database) {
  return s.prepare("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%' order by type,name").all()
}
const collection = { interface: 'recognized_list', queryKey: 'fixture', rdjb: '2,3', queriedAt: 'original time', createdAt: 'original creation', status: 'partial', completeness: 'unknown', provenanceState: 'unknown', parseState: 'absent', ruleVersion: 't01-fixture' } as const

it('upgrades legacy 0046 and an empty database to the same schema without inventing collection facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'collection-t01-'))
  const old = new Database(':memory:')
  const fresh = new Database(':memory:')
  try {
    old.pragma('foreign_keys = ON'); fresh.pragma('foreign_keys = ON')
    migrate(drizzle(old), { migrationsFolder: oldMigrations(root) })
    old.exec("insert into platform_query(interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) values('recognized_list','old','2,3','unchanged','failed','{bad','unchanged')")
    const before = old.prepare('select * from platform_query').all()
    migrate(drizzle(old), { migrationsFolder: folder })
    migrate(drizzle(fresh), { migrationsFolder: folder })
    expect(catalog(old)).toEqual(catalog(fresh))
    expect(old.prepare('select * from platform_query').all()).toEqual(before)
    expect(old.prepare('select * from platform_collection').all()).toEqual([])
    expect(old.pragma('foreign_key_check')).toEqual([])
    const db = drizzle(fresh, { schema })
    const inserted = db.insert(schema.platformCollection).values(collection).returning().get()
    expect(inserted).toMatchObject({ source: null, evidenceStatus: null, completedAt: null, fullRange: null, fetchedCount: null, declaredTotal: null, maxRequests: null, maxRows: null, maxDurationMs: null, pageSize: null, titleCode: null, lastCollectedAt: null, errorCode: null, errorMessage: null })
  } finally { old.close(); fresh.close(); rmSync(root, { recursive: true, force: true }) }
})

// Frozen 0027 expressions: independent of the new schema and any application extractor.
function legacyScope(s: Database.Database) {
  return s.prepare(`SELECT DISTINCT q.id query_id, scope.value rdjb FROM platform_query q,
    json_each(CASE WHEN json_valid(q.collection_evidence, 2)
      THEN CASE WHEN json_valid(json_extract(q.collection_evidence, '$.titleScope.rdjb'), 2)
        THEN json_extract(q.collection_evidence, '$.titleScope.rdjb') ELSE 'null' END
      ELSE 'null' END) scope WHERE scope.type = 'text' ORDER BY query_id, rdjb`).all()
}
function legacyErrors(s: Database.Database) {
  return s.prepare(`SELECT q.id query_id FROM platform_query q WHERE CASE
    WHEN q.collection_evidence IS NULL THEN 0
    WHEN NOT json_valid(q.collection_evidence, 2) THEN 1
    WHEN json_extract(q.collection_evidence, '$.titleScope.rdjb') IS NULL THEN 0
    WHEN NOT json_valid(json_extract(q.collection_evidence, '$.titleScope.rdjb'), 2) THEN 1
    ELSE 0 END = 1 ORDER BY query_id`).all()
}
it('preserves the independent 0027 oracle and old insert update delete triggers across upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'collection-oracle-'))
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON')
    migrate(drizzle(s), { migrationsFolder: oldMigrations(root) })
    const archives = [null, '{bad', '{titleScope:{rdjb:["2","3","2"," 2 ",2,true,null]}}', JSON.stringify({ titleScope: { rdjb: "['2',]" } }), '{titleScope:{rdjb:"not-json"}}', '{titleScope:{rdjb:2}}', '{titleScope:{rdjb:true}}', '{titleScope:{rdjb:null}}', '{titleScope:{rdjb:{a:"2"}}}', '{titleScope:{rdjb:"\\\"2\\\""}}', '{}']
    const insert = s.prepare("insert into platform_query(interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) values('recognized_list',?,'2,3','original',?,?,'original')")
    for (const status of ['success', 'no_record', 'failed', 'not_queried', 'partial']) {
      archives.forEach((archive, i) => insert.run(`${status}-${i}`, status, archive))
    }
    const before = s.prepare('select * from platform_query order by id').all()
    const triggers = s.prepare("select name,sql from sqlite_schema where type='trigger' order by name").all()
    const expected = legacyScope(s), errors = legacyErrors(s)
    migrate(drizzle(s), { migrationsFolder: folder })
    const assertOracle = () => {
      expect(s.prepare('select query_id,rdjb from platform_query_title_scope order by query_id,rdjb').all()).toEqual(legacyScope(s))
      expect(s.prepare('select query_id from platform_query_title_scope_error order by query_id').all()).toEqual(legacyErrors(s))
    }
    expect(legacyScope(s)).toEqual(expected); expect(legacyErrors(s)).toEqual(errors)
    expect(s.prepare('select * from platform_query order by id').all()).toEqual(before)
    expect(s.prepare("select name,sql from sqlite_schema where type='trigger' AND tbl_name NOT LIKE 'platform_archive%' AND tbl_name NOT LIKE 'platform_%archive_ref' AND tbl_name NOT LIKE 'platform_legacy_%' order by name").all()).toEqual(triggers)
    assertOracle()
    const id = Number(insert.run('post-upgrade', 'success', '{titleScope:{rdjb:["3"]}}').lastInsertRowid)
    assertOracle()
    s.prepare('update platform_query set collection_evidence=? where id=?').run('{bad', id); assertOracle()
    expect(s.prepare('select query_id from platform_query_title_scope_error where query_id=?').get(id)).toEqual({ query_id: id })
    s.prepare('update platform_query set collection_evidence=? where id=?').run('{titleScope:{rdjb:[" 2 ","2"]}}', id); assertOracle()
    expect(s.prepare('select rdjb from platform_query_title_scope where query_id=? order by rdjb').all(id)).toEqual([{ rdjb: ' 2 ' }, { rdjb: '2' }])
    s.prepare('delete from platform_query where id=?').run(id); assertOracle()
    expect(s.pragma('foreign_key_check')).toEqual([])
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

it('stores repeated page numbers failure and zero row pages and unfinished positions in original ordinal order', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON'); const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: folder })
    const c = db.insert(schema.platformCollection).values({ ...collection, evidenceStatus: 'auth_failed', status: 'failed', source: 'queryBusList', errorCode: 'auth_failed', errorMessage: '原错误', failureReason: '独立原因', maxRequests: 1, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 }).returning().get()
    expect(c).toMatchObject({ evidenceStatus: 'auth_failed', status: 'failed', failureReason: '独立原因', errorMessage: '原错误' })
    db.insert(schema.platformCollectionPage).values([
      { collectionId: c.id, ordinal: 0, rdjb: '3', pageNo: 2, fetchedCount: 1, sequenceStart: 1, sequenceEnd: 1, status: 'success', positionState: 'verified' },
      { collectionId: c.id, ordinal: 1, rdjb: '2', pageNo: 2, fetchedCount: 0, status: 'failed', errorCode: 'timeout', errorMessage: '原失败', positionState: 'unknown' },
      { collectionId: c.id, ordinal: 2, rdjb: '2', pageNo: 2, fetchedCount: 0, status: 'success', positionState: 'verified' },
      { collectionId: c.id, ordinal: 3, positionState: 'conflict' },
    ]).run()
    expect(s.prepare('select ordinal,rdjb,page_no,fetched_count,status,sequence_start,sequence_end from platform_collection_page order by ordinal').all()).toEqual([
      { ordinal: 0, rdjb: '3', page_no: 2, fetched_count: 1, status: 'success', sequence_start: 1, sequence_end: 1 },
      { ordinal: 1, rdjb: '2', page_no: 2, fetched_count: 0, status: 'failed', sequence_start: null, sequence_end: null },
      { ordinal: 2, rdjb: '2', page_no: 2, fetched_count: 0, status: 'success', sequence_start: null, sequence_end: null },
      { ordinal: 3, rdjb: null, page_no: null, fetched_count: null, status: null, sequence_start: null, sequence_end: null },
    ])
    db.insert(schema.platformCollectionUnfinished).values([0, 1].map(ordinal => ({ collectionId: c.id, ordinal, rdjb: ' 2 ', pageNo: 2 }))).run()
    expect(s.prepare('select ordinal,rdjb,page_no from platform_collection_unfinished order by ordinal').all()).toEqual([{ ordinal: 0, rdjb: ' 2 ', page_no: 2 }, { ordinal: 1, rdjb: ' 2 ', page_no: 2 }])
  } finally { s.close() }
})

it('retains every typed condition branch without coercing archived real array or object values', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON'); const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: folder })
    const c = db.insert(schema.platformCollection).values(collection).returning().get()
    const insert = s.prepare('insert into platform_collection_condition values(?,?,?,?,?)')
    const cases = [['name', 'text', ' 原名 ', null], ['uscc', 'absent', null, null], ['combination', 'null', null, null], ['sqsj', 'real', null, null], ['rddqrq', 'array', null, null], ['whpcyear', 'object', null, null], ['whpc', 'integer', null, -9007199254740991], ['szq', 'boolean', null, 0], ['orderField', 'text', '', null], ['orderDirection', 'boolean', null, 1]] as const
    for (const row of cases) insert.run(c.id, ...row)
    expect(s.prepare('select name,value_kind,text_value,integer_value from platform_collection_condition order by rowid').all()).toEqual(cases.map(([name, value_kind, text_value, integer_value]) => ({ name, value_kind, text_value, integer_value })))
    const update = s.prepare('update platform_collection_condition set value_kind=?,text_value=?,integer_value=? where name=?')
    for (const [kind, text, integer] of [['text', Buffer.from([0xff, 0x00, 0x32]), null], ['text', Buffer.alloc(0), null], ['text', null, null], ['text', 'x', 1], ['integer', null, null], ['integer', null, 1.5], ['integer', null, 9007199254740992], ['integer', '1', 1], ['boolean', null, 2], ['boolean', null, null], ['array', '[]', null], ['object', null, 1], ['null', 'null', null], ['absent', '', null], ['real', null, 1], ['invented', null, null]]) {
      expect(() => update.run(kind, text, integer, 'name'), `${kind}/${text}/${integer}`).toThrow(/CHECK/)
    }
    expect(() => insert.run(c.id, 'status', 'text', '通过', null)).toThrow(/CHECK/)
    expect(() => insert.run(c.id, 'name', 'text', 'duplicate', null)).toThrow(/UNIQUE/)
  } finally { s.close() }
})

it('rejects invalid numeric facts foreign keys and duplicate identities and rolls back the whole batch', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON'); const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: folder })
    const c = db.insert(schema.platformCollection).values(collection).returning().get()
    expect(() => db.insert(schema.platformCollection).values(collection).run()).toThrow()
    // Infrastructure-only SQL exercises SQLite affinity/checks, bypassing compile-time enums.
    for (const [column, invalid] of [['interface', 'invented'], ['status', 'auth_failed'], ['completeness', 'invented'], ['provenance_state', 'invented'], ['parse_state', 'unknown'], ['full_range', 2], ['full_range', 0.5], ['fetched_count', -1], ['declared_total', 'bad'], ['max_requests', 0], ['max_rows', -1], ['max_duration_ms', 1.5], ['page_size', 9007199254740992]]) {
      expect(() => s.prepare(`update platform_collection set ${column}=? where id=?`).run(invalid, c.id), String(column)).toThrow(/CHECK/)
    }
    expect(() => s.prepare('update platform_collection set title_code=? where id=?').run('missing', c.id)).toThrow(/FOREIGN KEY/)
    const page = s.prepare('insert into platform_collection_page(collection_id,ordinal,position_state,page_no,fetched_count,sequence_start,sequence_end) values(?,?,?,?,?,?,?)')
    for (const args of [[999, 0, 'unknown', null, null, null, null], [c.id, -1, 'unknown', null, null, null, null], [c.id, 0.5, 'unknown', null, null, null, null], [c.id, 0, 'invented', null, null, null, null], [c.id, 0, 'unknown', 0, null, null, null], [c.id, 0, 'unknown', 1, -1, null, null], [c.id, 0, 'verified', 1, 1, 2, 1], [c.id, 0, 'verified', 1, 1, 1, null]]) expect(() => page.run(...args)).toThrow(/CHECK|FOREIGN KEY/)
    page.run(c.id, 0, 'unknown', null, null, null, null)
    expect(() => page.run(c.id, 0, 'unknown', null, null, null, null)).toThrow(/UNIQUE/)
    expect(() => s.prepare('delete from platform_collection where id=?').run(c.id)).toThrow(/FOREIGN KEY/)
    expect(() => db.transaction(tx => {
      const next = tx.insert(schema.platformCollection).values({ ...collection, queryKey: 'rollback' }).returning().get()
      tx.insert(schema.platformCollectionUnfinished).values({ collectionId: next.id, ordinal: 0 }).run()
      tx.insert(schema.platformCollectionCondition).values({ collectionId: next.id, name: 'name', valueKind: 'text', textValue: 'valid' }).run()
      tx.insert(schema.platformCollectionPage).values({ collectionId: next.id, ordinal: 0, pageNo: -1, positionState: 'unknown' }).run()
    })).toThrow()
    expect(s.prepare('select query_key from platform_collection').all()).toEqual([{ query_key: 'fixture' }])
    expect(s.prepare('select * from platform_collection_unfinished').all()).toEqual([])
    expect(s.prepare('select * from platform_collection_condition').all()).toEqual([])
  } finally { s.close() }
})

it('keeps transition query primary keys and validates nullable collection foreign keys and target uniqueness', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON'); const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: folder })
    const c = db.insert(schema.platformCollection).values(collection).returning().get()
    const query = s.prepare("insert into platform_query(interface,query_key,queried_at,collection_evidence,created_at) values('recognized_list',?,'original',?,'original')")
    const a = Number(query.run('a', '{titleScope:{rdjb:["2"]}}').lastInsertRowid)
    const b = Number(query.run('b', '{titleScope:{rdjb:["2"]}}').lastInsertRowid)
    const e = Number(query.run('e', '{bad').lastInsertRowid)
    const f = Number(query.run('f', '{bad').lastInsertRowid)
    expect(s.prepare('select collection_id from platform_query_title_scope').all()).toEqual([{ collection_id: null }, { collection_id: null }])
    s.prepare('update platform_query_title_scope set collection_id=? where query_id=?').run(c.id, a)
    expect(() => s.prepare('update platform_query_title_scope set collection_id=? where query_id=?').run(c.id, b)).toThrow(/UNIQUE/)
    expect(() => s.prepare('update platform_query_title_scope set collection_id=999 where query_id=?').run(b)).toThrow(/FOREIGN KEY/)
    s.prepare('update platform_query_title_scope_error set collection_id=? where query_id=?').run(c.id, e)
    expect(() => s.prepare('update platform_query_title_scope_error set collection_id=? where query_id=?').run(c.id, f)).toThrow(/UNIQUE/)
    expect(() => s.prepare('update platform_query_title_scope_error set collection_id=999 where query_id=?').run(f)).toThrow(/FOREIGN KEY/)
    expect(() => s.prepare('insert into platform_query_title_scope(query_id,rdjb) values(999,?)').run('2')).toThrow(/FOREIGN KEY/)
    expect(() => s.prepare('insert into platform_query_title_scope_error(query_id) values(999)').run()).toThrow(/FOREIGN KEY/)
    for (const table of ['platform_query_title_scope', 'platform_query_title_scope_error']) {
      expect(s.pragma(`foreign_key_list(${table})`)).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'query_id', table: 'platform_query', on_delete: 'CASCADE' }),
        expect.objectContaining({ from: 'collection_id', table: 'platform_collection', on_delete: 'RESTRICT' }),
      ]))
    }
    expect(() => s.prepare('delete from platform_collection where id=?').run(c.id)).toThrow(/FOREIGN KEY/)
    s.prepare('delete from platform_query where id in (?,?)').run(a, e)
    expect(s.prepare('select query_id from platform_query_title_scope').all()).toEqual([{ query_id: b }])
    expect(s.prepare('select query_id from platform_query_title_scope_error').all()).toEqual([{ query_id: f }])
  } finally { s.close() }
})

it('rolls back DDL data and migration registration if a later statement fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'collection-rollback-'))
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON')
    const staged = oldMigrations(root)
    migrate(drizzle(s), { migrationsFolder: staged })
    const before = catalog(s), registrations = s.prepare('select * from __drizzle_migrations').all()
    const latest = journal.entries.find((e: { idx: number }) => e.idx === 47)
    expect(latest.idx).toBe(47)
    const sql = readFileSync(join(folder, `${latest.tag}.sql`), 'utf8')
    // A later invalid row must roll back all preceding CREATE/ALTER and the valid row.
    writeFileSync(join(staged, `${latest.tag}.sql`), sql + `\n--> statement-breakpoint\nINSERT INTO platform_collection(interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) VALUES('recognized_list','rollback','2','raw','raw','partial','unknown','unknown','absent','fixture');\n--> statement-breakpoint\nINSERT INTO platform_collection_page(collection_id,ordinal,page_no,position_state) VALUES(1,0,-1,'unknown');`)
    writeFileSync(join(staged, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((e: { idx: number }) => e.idx <= 47) }))
    expect(() => migrate(drizzle(s), { migrationsFolder: staged })).toThrow(/Failed to run/)
    expect(catalog(s)).toEqual(before)
    expect(s.prepare('select * from __drizzle_migrations').all()).toEqual(registrations)
    expect(s.pragma('foreign_key_check')).toEqual([])
    migrate(drizzle(s), { migrationsFolder: folder })
    expect(s.prepare('select * from platform_collection').all()).toEqual([])
    expect(s.prepare('select count(*) n from __drizzle_migrations').get()).toEqual({ n: journal.entries.length })
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

it('matches the installed Drizzle schema columns indexes and foreign keys to migrated SQLite', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON'); migrate(drizzle(s), { migrationsFolder: folder })
    for (const table of [schema.platformCollection, schema.platformCollectionPage, schema.platformCollectionCondition, schema.platformCollectionUnfinished, schema.platformQueryTitleScope, schema.platformQueryTitleScopeError]) {
      const config = getTableConfig(table)
      const actual = s.prepare(`pragma table_info(${config.name})`).all()
      expect(actual).toHaveLength(config.columns.length)
      for (const column of config.columns) expect(actual).toContainEqual(expect.objectContaining({ name: column.name, type: column.getSQLType().toUpperCase() }))
      const fks = s.pragma(`foreign_key_list(${config.name})`)
      expect(fks).toHaveLength(config.foreignKeys.length)
      for (const fk of config.foreignKeys) {
        const ref = fk.reference()
        expect(fks).toContainEqual(expect.objectContaining({ table: getTableName(ref.foreignTable), from: ref.columns[0]!.name, to: ref.foreignColumns[0]!.name, on_delete: (fk.onDelete ?? 'no action').toUpperCase() }))
      }
      const indexes = s.pragma(`index_list(${config.name})`)
      for (const index of config.indexes) expect(indexes).toContainEqual(expect.objectContaining({ name: index.config.name, unique: Number(index.config.unique) }))
    }
    const unfinished = s.prepare('insert into platform_collection_unfinished(collection_id,ordinal,page_no) values(?,?,?)')
    const condition = s.prepare("insert into platform_collection_condition(collection_id,name,value_kind) values(?,'name','absent')")
    expect(() => unfinished.run(999, 0, null)).toThrow(/FOREIGN KEY/)
    expect(() => condition.run(999)).toThrow(/FOREIGN KEY/)
    const db = drizzle(s, { schema }); const c = db.insert(schema.platformCollection).values(collection).returning().get()
    unfinished.run(c.id, 0, null)
    expect(() => unfinished.run(c.id, 0, null)).toThrow(/UNIQUE/)
    expect(() => unfinished.run(c.id, -1, null)).toThrow(/CHECK/)
    expect(() => unfinished.run(c.id, 1, 0)).toThrow(/CHECK/)
  } finally { s.close() }
})
