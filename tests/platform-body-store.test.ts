import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getTableColumns, sql } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { createPlatformBodyStore, MAX_PLATFORM_BODY_PARTS, type PlatformBodyRoot, type PlatformBodyOwner } from '../lib/platform/body-store'
import { legacyBodySelection, logicalByteLengthSql, logicalTextSql } from '../lib/platform/body-sql'

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>()
  return { ...actual, createHash: vi.fn(actual.createHash) }
})
const handles: Database.Database[] = []
afterEach(() => { handles.splice(0).forEach(db => db.close()); vi.mocked(createHash).mockClear() })
function fixture(verbose?: (message: string) => void) {
  const sqlite = new Database(':memory:', { verbose: verbose ? message => verbose(String(message)) : undefined }); handles.push(sqlite)
  sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolve('db/migrations') })
  db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'fixture', queriedAt: '2026-10-24', rawResponse: 'inline response' }).run()
  db.insert(schema.platformRelation).values({ queryId: 1, sequenceNo: 1, rawFields: { old: 'inline' }, sourceText: 'inline source' }).run()
  db.insert(schema.platformBusinessRecord).values({ interface: 'business_list', platformKey: 'fixture', identityRuleVersion: 'fixture' }).run()
  db.insert(schema.platformBusinessRecordVersion).values({ recordId: 1, hashAlgorithm: 'fixture', contentHash: 'fixture', canonicalRawJson: '{"old":"inline"}' }).run()
  return { sqlite, db, store: createPlatformBodyStore(sqlite) }
}
function counts(sqlite: Database.Database) {
  return ['leaf', 'root', 'part'].map(name => sqlite.prepare(`SELECT count(*) n FROM platform_body_${name}`).get())
}
function rootId(id: number) { return id as PlatformBodyRoot }

it('shares exact bytes across typed owners without collapsing observations or representations', () => {
  const { sqlite, store } = fixture()
  const text = '{"b":2,"a":1}'
  const shared = store.intern(text)!
  for (const owner of [
    { kind: 'relation', id: 1, field: 'rawFields' }, { kind: 'relation', id: 1, field: 'sourceText' },
    { kind: 'query', id: 1, field: 'rawResponse' }, { kind: 'query', id: 1, field: 'collectionEvidence' },
    { kind: 'version', id: 1, field: 'canonicalRawJson' },
  ] as const) { expect(store.intern(text)).toBe(shared); store.setReference(owner, shared) }
  expect(counts(sqlite)).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }])
  expect(new Set([shared, store.intern('{"a":1,"b":2}'), store.intern('{ "b":2,"a":1}')]).size).toBe(3)
  expect(sqlite.prepare('SELECT raw_fields, source_text FROM platform_relation').get()).toEqual({ raw_fields: '{"old":"inline"}', source_text: 'inline source' })
  expect(sqlite.prepare('SELECT canonical_raw_json FROM platform_business_record_version').get()).toEqual({ canonical_raw_json: '{"old":"inline"}' })
})

it('preserves NULL empty text-null invalid JSON Unicode BOM and NUL exactly', () => {
  const { sqlite, store, db } = fixture()
  expect(store.intern(null)).toBeNull(); expect(store.readText(null)).toBeNull()
  expect(store.logicalLength(null)).toBeNull(); expect(store.readRange(null, 0, 1)).toBeNull()
  expect(counts(sqlite)).toEqual([{ n: 0 }, { n: 0 }, { n: 0 }])
  for (const text of ['', 'null', '{invalid', '中文🙂', '\ufeff首字', 'a\0中🙂z']) {
    const id = store.intern(text)!
    expect(store.readText(id)).toBe(text)
    expect(store.logicalLength(id)).toBe(Buffer.byteLength(text))
    store.setReference({ kind: 'query', id: 1, field: 'rawResponse' }, id)
    expect(db.select({ text: logicalTextSql('query', 'rawResponse', schema.platformQuery.id, schema.platformQuery.rawResponse) }).from(schema.platformQuery).get()).toEqual({ text })
  }
  expect(() => store.intern('\ud800')).toThrow('platform_body_invalid_utf8')
  expect(() => store.intern(Buffer.from('text') as never)).toThrow('platform_body_storage_class')
  expect(() => store.internParts([])).toThrow('platform_body_invalid_parts')
  expect(() => store.internParts([rootId(1)] as never)).toThrow('platform_body_storage_class')
})

it('compares full bytes after root and leaf digest hits and rolls back collisions', async () => {
  const { sqlite, store } = fixture()
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  const first = store.intern('abcd')!
  const before = counts(sqlite)
  // Force a same-length root digest collision; then a different-length collision.
  for (const input of ['abce', 'longer']) {
    const fixed = actual.createHash('sha256'); vi.spyOn(fixed, 'digest').mockReturnValue(actual.createHash('sha256').update('abcd').digest('hex') as never)
    vi.mocked(createHash).mockReturnValueOnce(fixed)
    expect(() => store.intern(input)).toThrow('platform_body_hash_collision')
    expect(counts(sqlite)).toEqual(before)
  }
  // New root hash, colliding first leaf hash. No temporary root/leaf survives.
  const fixed = actual.createHash('sha256'); vi.spyOn(fixed, 'digest').mockReturnValue(actual.createHash('sha256').update('abcd').digest('hex') as never)
  vi.mocked(createHash).mockImplementationOnce(actual.createHash).mockReturnValueOnce(fixed)
  expect(() => store.internParts(['abce', '!'])).toThrow('platform_body_hash_collision')
  expect(counts(sqlite)).toEqual(before); expect(store.readText(first)).toBe('abcd')
})

it('composes ordered repeated leaves and exhaustively reads half-open byte ranges with indexed seeks', () => {
  const statements: string[] = []
  const { sqlite, store } = fixture(message => statements.push(message))
  const parts = ['{"rows":[', '{"name":"中🙂"}', ',', '{"name":"中🙂"}', '],"unknown":true}']
  const id = store.internParts(parts), exact = Buffer.from(parts.join(''))
  expect(store.readText(id)).toBe(parts.join(''))
  expect(store.intern(parts.join(''))).toBe(id)
  expect(counts(sqlite)).toEqual([{ n: 4 }, { n: 1 }, { n: 5 }])
  const ids = sqlite.prepare('SELECT leaf_id FROM platform_body_part WHERE root_id=? ORDER BY logical_start').all(id) as { leaf_id: number }[]
  expect(ids[1]!.leaf_id).toBe(ids[3]!.leaf_id)
  for (let offset = 0; offset <= exact.length + 1; offset++) for (let length = 0; length <= exact.length + 1; length++) {
    expect(store.readRange(id, offset, length)).toEqual(exact.subarray(offset, offset + length))
  }
  for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, Infinity], [NaN, 0], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
    expect(() => store.readRange(id, offset!, length!)).toThrow('platform_body_invalid_range')
  }
  statements.length = 0
  expect(store.readRange(id, 0, 1)).toEqual(Buffer.from('{'))
  expect(statements.filter(s => /FROM platform_body_leaf/.test(s))).toHaveLength(1)
  expect(statements.some(s => /SELECT substr\(bytes, 1(?:\.0)?, 1(?:\.0)?\)/.test(s))).toBe(true)
  for (const query of [
    'SELECT logical_start FROM platform_body_part WHERE root_id=1 AND logical_start<=10 ORDER BY logical_start DESC LIMIT 1',
    'SELECT logical_start,byte_length,leaf_id FROM platform_body_part WHERE root_id=1 AND logical_start>=0 AND logical_start<10 ORDER BY logical_start',
  ]) {
    const plan = JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all())
    expect(plan).toContain('SEARCH platform_body_part USING'); expect(plan).not.toContain('TEMP B-TREE')
  }
})

it('bounds explicit fragment inputs and seals contiguous leaf-only immutable roots', () => {
  const { sqlite, store } = fixture()
  const id = store.internParts(Array(MAX_PLATFORM_BODY_PARTS).fill('a'))
  expect(store.readText(id)).toBe('a'.repeat(MAX_PLATFORM_BODY_PARTS))
  const before = counts(sqlite)
  expect(() => store.internParts(Array(MAX_PLATFORM_BODY_PARTS + 1).fill('a'))).toThrow('platform_body_invalid_parts')
  expect(counts(sqlite)).toEqual(before)
  for (const query of [
    'UPDATE platform_body_leaf SET bytes=x\'62\' WHERE id=1', 'DELETE FROM platform_body_leaf WHERE id=1',
    'UPDATE platform_body_root SET byte_length=1 WHERE id=1', 'DELETE FROM platform_body_root WHERE id=1',
    'UPDATE platform_body_part SET logical_start=2 WHERE root_id=1', 'DELETE FROM platform_body_part WHERE root_id=1',
    'INSERT INTO platform_body_part VALUES(1,64,1,1)',
    "INSERT INTO platform_body_root(digest,byte_length,sealed) VALUES('sealed',1,1)",
    "INSERT INTO platform_body_leaf(digest,byte_length,bytes) VALUES('text',1,'a')",
    "INSERT INTO platform_body_leaf(digest,byte_length,bytes) VALUES('badlen',2,x'61')",
    "INSERT INTO platform_body_root(digest,byte_length) VALUES('negative',-1)",
  ]) expect(() => sqlite.exec(query)).toThrow()
  sqlite.exec("INSERT INTO platform_body_root(id,digest,byte_length) VALUES(2,'new',65)")
  expect(() => sqlite.exec('INSERT INTO platform_body_part VALUES(2,1,1,1)')).toThrow('platform_body_invalid_part')
  expect(() => sqlite.exec('INSERT INTO platform_body_part VALUES(2,0,999,1)')).toThrow('platform_body_invalid_part')
  expect(() => sqlite.exec('UPDATE platform_body_root SET sealed=1 WHERE id=2')).toThrow('platform_body_invalid_seal')
  for (let offset = 0; offset < MAX_PLATFORM_BODY_PARTS; offset++) sqlite.prepare('INSERT INTO platform_body_part VALUES(2,?,1,1)').run(offset)
  expect(() => sqlite.exec('INSERT INTO platform_body_part VALUES(2,64,1,1)')).toThrow('platform_body_invalid_part')
})

it('enforces typed owner foreign keys and rejects missing or unsealed references', () => {
  const { sqlite, store } = fixture()
  const id = store.intern('body')!
  for (const [table, field] of [['relation', 'rawFields'], ['query', 'rawResponse'], ['version', 'canonicalRawJson']]) {
    expect(() => sqlite.prepare(`INSERT INTO platform_${table}_body_ref VALUES(999,?,?)`).run(field, id)).toThrow(/FOREIGN KEY/)
    expect(() => sqlite.prepare(`INSERT INTO platform_${table}_body_ref VALUES(1,'wrong',?)`).run(id)).toThrow(/CHECK/)
    expect(() => sqlite.prepare(`INSERT INTO platform_${table}_body_ref VALUES(1,?,999)`).run(field)).toThrow('platform_body_bad_reference')
    sqlite.prepare(`INSERT INTO platform_${table}_body_ref VALUES(1,?,?)`).run(field, id)
    expect(() => sqlite.exec(`UPDATE platform_${table}_body_ref SET root_id=999`)).toThrow('platform_body_bad_reference')
  }
  sqlite.exec("INSERT INTO platform_body_root(id,digest,byte_length) VALUES(2,'unfinished',0)")
  expect(() => store.setReference({ kind: 'query', id: 1, field: 'rawResponse' }, rootId(2))).toThrow('platform_body_bad_root')
  expect(() => store.setReference({ kind: 'query', id: 1, field: 'sourceText' } as never, id)).toThrow('platform_body_invalid_owner')
  for (const table of ['platform_relation', 'platform_query', 'platform_business_record_version']) expect(() => sqlite.exec(`DELETE FROM ${table} WHERE id=1`)).toThrow(/FOREIGN KEY/)
  store.setReference({ kind: 'query', id: 1, field: 'rawResponse' }, null)
  expect(sqlite.prepare('SELECT count(*) n FROM platform_query_body_ref').get()).toEqual({ n: 0 })
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('rolls back leaf root part and owner writes at injected failure points without weakening guards', () => {
  const { sqlite, store } = fixture()
  store.intern('existing')
  for (const table of ['platform_body_leaf', 'platform_body_part', 'platform_query_body_ref']) {
    const before = counts(sqlite)
    sqlite.exec(`CREATE TRIGGER fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected_failure'); END`)
    expect(() => sqlite.transaction(() => {
      const id = store.internParts(['new', 'body'])
      store.setReference({ kind: 'query', id: 1, field: 'rawResponse' }, id)
    })()).toThrow('injected_failure')
    expect(counts(sqlite)).toEqual(before)
    expect(sqlite.prepare('SELECT count(*) n FROM platform_query_body_ref').get()).toEqual({ n: 0 })
    sqlite.exec('DROP TRIGGER fault')
  }
  expect(() => sqlite.exec('UPDATE platform_body_leaf SET byte_length=99')).toThrow('platform_body_immutable')
})

it('uses immutable root metadata for byte budgets without reading leaf text', () => {
  const statements: string[] = []
  const { store, db } = fixture(message => statements.push(message))
  const id = store.intern('中'.repeat(22001))!
  store.setReference({ kind: 'relation', id: 1, field: 'rawFields' }, id)
  statements.length = 0
  expect(store.logicalLength(id)).toBe(66003)
  const budget = logicalByteLengthSql('relation', 'rawFields', schema.platformRelation.id, schema.platformRelation.rawFields)
  expect(db.select({ length: budget, underProofBudget: sql`${budget} <= 65536` }).from(schema.platformRelation).get()).toEqual({ length: 66003, underProofBudget: 0 })
  expect(statements.join('\n')).not.toMatch(/platform_body_(leaf|part|logical_text)/)
  expect(() => store.logicalLength(rootId(999))).toThrow('platform_body_bad_root')
})

it('keeps SQL JSON types small projections and legacy hydration field order and decoders', () => {
  const { sqlite, store, db } = fixture()
  const text = '{"z":true,"a":null,"array":[1,"中🙂"],"number":1}'
  const beforeRelation = db.select().from(schema.platformRelation).get()!
  const beforeQuery = db.select().from(schema.platformQuery).get()!
  const beforeVersion = db.select().from(schema.platformBusinessRecordVersion).get()!
  expect(db.select(legacyBodySelection('relation')).from(schema.platformRelation).get()).toEqual(beforeRelation)
  for (const owner of [{ kind: 'relation', id: 1, field: 'rawFields' }, { kind: 'query', id: 1, field: 'collectionEvidence' }, { kind: 'version', id: 1, field: 'canonicalRawJson' }] satisfies PlatformBodyOwner[]) store.setReference(owner, store.internParts([text.slice(0, 10), text.slice(10)]))
  const logical = logicalTextSql('relation', 'rawFields', schema.platformRelation.id, schema.platformRelation.rawFields)
  expect(db.select({ projection: sql`json_extract(${logical}, '$.z', '$.a', '$.array', '$.absent')`, type: sql`json_type(${logical}, '$.z')`, numeric: sql`json_extract(${logical}, '$.number')` }).from(schema.platformRelation).get()).toEqual({ projection: '[true,null,[1,"中🙂"],null]', type: 'true', numeric: 1 })
  for (const [kind, table, expected] of [
    ['relation', schema.platformRelation, { ...beforeRelation, rawFields: JSON.parse(text) }],
    ['query', schema.platformQuery, { ...beforeQuery, collectionEvidence: JSON.parse(text) }],
    ['version', schema.platformBusinessRecordVersion, { ...beforeVersion, canonicalRawJson: text }],
  ] as const) {
    const row = db.select(legacyBodySelection(kind)).from(table).get()!
    expect(Object.keys(row)).toEqual(Object.keys(getTableColumns(table)))
    expect(JSON.stringify(row)).toBe(JSON.stringify(expected))
    expect(Object.keys(row)).not.toContain('rootId')
  }
  store.setReference({ kind: 'relation', id: 1, field: 'rawFields' }, store.intern('null'))
  expect(db.select(legacyBodySelection('relation')).from(schema.platformRelation).get()!.rawFields).toBeNull()
  store.setReference({ kind: 'relation', id: 1, field: 'rawFields' }, store.intern('{invalid'))
  expect(() => db.select(legacyBodySelection('relation')).from(schema.platformRelation).get()).toThrow()
  // Same legacy decoder rejects invalid inline JSON too.
  store.setReference({ kind: 'relation', id: 1, field: 'rawFields' }, null)
  sqlite.exec("UPDATE platform_relation SET raw_fields='{invalid'")
  expect(() => db.select(legacyBodySelection('relation')).from(schema.platformRelation).get()).toThrow()
})

it('fails explicitly on corrupt refs leaves lengths layouts and unsupported storage conversions', () => {
  for (const corruption of ['missing_leaf', 'leaf_length', 'root_length', 'layout', 'missing_root', 'unsealed', 'digest', 'invalid_utf8'] as const) {
    const { sqlite, store, db } = fixture()
    const id = store.internParts(['abc', 'def'])
    store.setReference({ kind: 'query', id: 1, field: 'rawResponse' }, id)
    // Deliberate out-of-band fault injection, confined to this synthetic DB. Production guards remain intact.
    sqlite.pragma('foreign_keys=OFF'); sqlite.pragma('ignore_check_constraints=ON')
    for (const trigger of ['platform_body_leaf_no_update', 'platform_body_leaf_no_delete', 'platform_body_part_no_update', 'platform_body_root_seal', 'platform_body_root_no_delete']) sqlite.exec(`DROP TRIGGER ${trigger}`)
    const changes = {
      missing_leaf: 'DELETE FROM platform_body_leaf WHERE id=1', leaf_length: 'UPDATE platform_body_leaf SET byte_length=99 WHERE id=1',
      root_length: 'UPDATE platform_body_root SET byte_length=99', layout: 'UPDATE platform_body_part SET logical_start=2 WHERE logical_start=3',
      missing_root: 'DELETE FROM platform_body_root', unsealed: 'UPDATE platform_body_root SET sealed=0',
      digest: "UPDATE platform_body_root SET digest='corrupt'", invalid_utf8: "UPDATE platform_body_leaf SET bytes=x'ffffff' WHERE id=1",
    }
    sqlite.exec(changes[corruption])
    expect(() => store.readText(id), corruption).toThrow(/platform_body_/)
    const expression = logicalTextSql('query', 'rawResponse', schema.platformQuery.id, schema.platformQuery.rawResponse)
    // Native SQL validates structural metadata; immutable write-time UTF-8/digest validation
    // remains the trust boundary. It cannot recompute SHA-256 without a JS UDF.
    if (corruption !== 'digest' && corruption !== 'invalid_utf8') expect(() => db.select({ text: expression }).from(schema.platformQuery).get(), corruption).toThrow(/malformed JSON/)
  }
  const { sqlite, store, db } = fixture()
  expect(() => store.readRange(rootId(999), 0, 1)).toThrow('platform_body_bad_root')
  sqlite.exec("UPDATE platform_query SET raw_response=x'616263'")
  for (const expression of [logicalTextSql('query', 'rawResponse', schema.platformQuery.id, schema.platformQuery.rawResponse), logicalByteLengthSql('query', 'rawResponse', schema.platformQuery.id, schema.platformQuery.rawResponse)]) expect(() => db.select({ value: expression }).from(schema.platformQuery).get()).toThrow(/malformed JSON/)
  const utf16 = new Database(':memory:'); handles.push(utf16); utf16.pragma('foreign_keys=ON'); utf16.pragma("encoding='UTF-16le'")
  expect(() => createPlatformBodyStore(utf16)).toThrow('platform_body_unsupported_encoding')
})

it('upgrades pre-0029 SQLite without changing legacy schema data triggers or NOT NULL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'body278-migration-'))
  const sqlite = new Database(':memory:'); handles.push(sqlite)
  try {
    sqlite.pragma('foreign_keys=ON')
    const folder = resolve('db/migrations')
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
    const oldFolder = join(dir, 'old'); mkdirSync(join(oldFolder, 'meta'), { recursive: true })
    const entries = journal.entries.filter((e: { idx: number }) => e.idx < 29)
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    for (const entry of entries) copyFileSync(join(folder, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`))
    const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: oldFolder })
    db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'fixture', queriedAt: 'fixture', rawResponse: '\0原🙂', collectionEvidence: { titleScope: { rdjb: ['2'] } } as never }).run()
    db.insert(schema.platformRelation).values({ queryId: 1, sequenceNo: 1, rawFields: { z: null, a: true }, sourceText: 'source' }).run()
    db.insert(schema.platformBusinessRecord).values({ interface: 'business_list', platformKey: 'fixture', identityRuleVersion: 'fixture' }).run()
    db.insert(schema.platformBusinessRecordVersion).values({ recordId: 1, hashAlgorithm: 'fixture', contentHash: 'fixture', canonicalRawJson: ' {"z":1} ' }).run()
    const oldSchema = sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE '__drizzle%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%' ORDER BY name").all() as { name: string }[]
    const contents = () => tables.map(({ name }) => [name, sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
    const before = contents()
    migrate(db, { migrationsFolder: folder }); migrate(db, { migrationsFolder: folder })
    expect(contents()).toEqual(before)
    const names = new Set(oldSchema.map(row => row.name))
    expect(sqlite.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all().filter(row => names.has((row as { name: string }).name))).toEqual(oldSchema)
    expect((sqlite.pragma('table_info(platform_business_record_version)') as { name: string; notnull: number }[]).find(row => row.name === 'canonical_raw_json')!.notnull).toBe(1)
    expect(() => sqlite.exec('UPDATE platform_business_record_version SET canonical_raw_json=NULL')).toThrow(/NOT NULL/)
    expect(() => sqlite.exec("INSERT INTO platform_query(interface,query_key,rdjb,queried_at,status,created_at) SELECT interface,query_key,rdjb,queried_at,status,created_at FROM platform_query")).toThrow(/UNIQUE/)
    expect(() => sqlite.exec("INSERT INTO platform_relation(query_id,sequence_no,created_at) VALUES(999,1,'fixture')")).toThrow(/FOREIGN KEY/)
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok'); expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


it('reads mixed owner sources through one seam and keeps inline range and NULL semantics', () => {
  const { sqlite, store } = fixture()
  const owner = { kind: 'query', id: 1, field: 'rawResponse' } as const
  const text = 'a中🙂\0z'
  sqlite.prepare('UPDATE platform_query SET raw_response=?').run(text)
  for (const pooled of [false, true]) {
    if (pooled) store.setReference(owner, store.internParts(['a中', '🙂\0z']))
    expect(store.readText(owner)).toBe(text)
    expect(store.logicalLength(owner)).toBe(10)
    expect(store.readRange(owner, 2, 4)).toEqual(Buffer.from(text).subarray(2, 6))
    expect(store.readRange(owner, Number.MAX_SAFE_INTEGER, 1)).toEqual(Buffer.alloc(0))
  }
  store.setReference(owner, null)
  sqlite.exec('UPDATE platform_query SET raw_response=NULL')
  expect(store.readText(owner)).toBeNull(); expect(store.logicalLength(owner)).toBeNull(); expect(store.readRange(owner, 0, 2)).toBeNull()
  expect(() => store.readText({ ...owner, id: 999 })).toThrow('platform_body_missing_owner')
  sqlite.exec("UPDATE platform_query SET raw_response=x'61'")
  for (const read of [() => store.readText(owner), () => store.logicalLength(owner), () => store.readRange(owner, 0, 1)]) expect(read).toThrow('platform_body_storage_class')
  sqlite.exec("UPDATE platform_query SET raw_response=CAST(x'ff' AS TEXT)")
  expect(() => store.readText(owner)).toThrow('platform_body_invalid_utf8')
  sqlite.pragma('foreign_keys=OFF')
  expect(() => createPlatformBodyStore(sqlite)).toThrow('platform_body_foreign_keys_required')
})

it('keeps native SQL aggregation confined to the selected root and preserves SQL NULL and UTF8 budget edges', () => {
  const { sqlite, store, db } = fixture()
  const owner = { kind: 'query', id: 1, field: 'rawResponse' } as const
  const text = logicalTextSql('query', 'rawResponse', schema.platformQuery.id, schema.platformQuery.rawResponse)
  const length = logicalByteLengthSql('query', 'rawResponse', schema.platformQuery.id, schema.platformQuery.rawResponse)
  sqlite.exec('UPDATE platform_query SET raw_response=NULL')
  expect(db.select({ text, length }).from(schema.platformQuery).get()).toEqual({ text: null, length: null })
  for (const budget of [65536, 4 * 1024 * 1024, 8 * 1024 * 1024]) for (const delta of [-1, 0, 1]) {
    // Metadata assertions are independent of the physical pointer length.
    const body = 'x'.repeat(budget + delta - 3) + '中'
    const id = store.intern(body)!
    store.setReference(owner, id)
    expect(store.logicalLength(owner)).toBe(budget + delta)
    expect(db.select({ length, fits: sql`${length} <= ${budget}` }).from(schema.platformQuery).get()).toEqual({ length: budget + delta, fits: delta <= 0 ? 1 : 0 })
  }
  store.setReference(owner, store.internParts(['{"a":', 'true}']))
  // An unrelated corrupt root must not be aggregated by this small SQL projection.
  sqlite.exec("INSERT INTO platform_body_root(digest,byte_length) VALUES('unselected-corrupt-root',1)")
  const query = db.select({ value: sql`json_extract(${text}, '$.a')`.as('value') }).from(schema.platformQuery).toSQL()
  expect(sqlite.prepare(query.sql).get(...query.params)).toEqual({ value: 1 })
  const plan = JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params))
  expect(plan).toContain('SEARCH _body_root USING INTEGER PRIMARY KEY')
  expect(plan).not.toContain('SCAN _body_root')
})
