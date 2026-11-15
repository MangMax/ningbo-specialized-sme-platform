import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, describe, expect, it } from 'vitest'
import * as schema from '../../../upgrade/legacy-schema'
import { parseApplyRecord } from '../../../lib/platform/apply-record'
import { parseBusinessProcess } from '../../../lib/platform/business-projection'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
const migrations = resolve(import.meta.dirname, '../../../db/migrations')
const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
const cases: [string, string | null][] = [
  ['{"rdjb":"1"}', '1'], ['{"rdjb":"2"}', '2'], ['{"rdjb":"3"}', '3'],
  ['{"rdjb":" unknown "}', 'unknown'], ['{}', null], ['{"rdjb":""}', null],
  [JSON.stringify({ rdjb: whitespace }), null], [JSON.stringify({ rdjb: `${whitespace}3${whitespace}` }), '3'],
  ['not-json', null], ['{"rdjb":3}', null], ['{"rdjb":null}', null],
  ['{"rdjb":true}', null], ['{"rdjb":[]}', null], ['{"rdjb":{}}', null],
  ['[{"rdjb":"1"}]', null], ['"1"', null], ['null', null],
  [JSON.stringify({ rdjb: '\u0085unknown\u0085' }), '\u0085unknown\u0085'],
]
function fixture(legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'row-title-')); dirs.push(dir)
  const sqlite = new Database(join(dir, 'fixture.sqlite'))
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  if (legacy) {
    const pre = join(dir, 'pre'); cpSync(migrations, pre, { recursive: true })
    const journalPath = join(pre, 'meta/_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 42)
    writeFileSync(journalPath, JSON.stringify(journal))
    migrate(db, { migrationsFolder: pre })
  } else migrate(db, { migrationsFolder: migrations })
  const upgrade = join(dir, 'through43')
  if (legacy) {
    cpSync(migrations, upgrade, { recursive: true })
    const journalPath = join(upgrade, 'meta/_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 43)
    writeFileSync(journalPath, JSON.stringify(journal))
  }
  return { sqlite, db, upgrade }
}
function snapshot(sqlite: Database.Database) {
  const result: Record<string, unknown> = {}
  for (const table of ['platform_relation', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection']) {
    result[table] = sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => {
      const { title_raw: _derived, ...original } = row as Record<string, unknown>
      // recognized title_raw is pre-existing and must be byte-identical too.
      return table === 'platform_recognized_projection' ? row : original
    })
  }
  return result
}

describe('0043 row-owned platform titles', () => {
  it('backfills only row strings through 0042 upgrade and preserves every original column and journal replay', () => {
    const { sqlite, db, upgrade } = fixture(true)
    try {
      let id = 0
      for (const source of ['apply', 'business'] as const) {
        const queryId = db.insert(schema.platformQuery).values({ interface: source === 'apply' ? 'apply_list' : 'business_list', queryKey: source, rdjb: 'query-scope', queriedAt: 'frozen' }).returning().get().id
        for (const [raw] of cases) {
          id++
          sqlite.prepare('INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,?,?,?,?,?)').run(id, queryId, id, `key-${id}`, raw, 'frozen')
          sqlite.prepare('INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(?,?,?,?,?)').run(id, `${source}_list`, `key-${id}`, 'platform-observation-v1', 'frozen')
          sqlite.prepare('INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(?,?,?,?,?,?)').run(id, id, 'platform-row-json-v1', `literal-hash-${id}`, raw, 'frozen')
          sqlite.prepare(`INSERT INTO platform_${source}_projection(version_id,record_id,rule_version,created_at) VALUES(?,?,?,?)`).run(id, id, `platform-${source}-v1`, 'frozen')
          sqlite.prepare("INSERT INTO platform_business_observation(relation_id,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(?,?,?,'resolved','verified','relation_key','platform-observation-v1',?,'frozen')").run(id, id, id, `literal-fingerprint-${id}`)
        }
      }
      // Existing recognized values deliberately differ from canonical rdjb: 0043 must not reinterpret them.
      sqlite.prepare("INSERT INTO platform_recognized_projection(version_id,record_id,title_raw,rule_version,created_at) VALUES(1,1,' preserved recognized ','platform-recognized-v1','frozen')").run()
      const before = snapshot(sqlite)
      expect(sqlite.prepare('PRAGMA table_info(platform_relation)').all()).not.toContainEqual(expect.objectContaining({ name: 'title_raw' }))
      migrate(db, { migrationsFolder: upgrade })
      expect(snapshot(sqlite)).toEqual(before)
      const expected = [...cases, ...cases].map(([, title_raw]) => ({ title_raw }))
      expect(sqlite.prepare('SELECT title_raw FROM platform_relation ORDER BY id').all()).toEqual(expected)
      for (const source of ['apply', 'business']) expect(sqlite.prepare(`SELECT title_raw FROM platform_${source}_projection ORDER BY version_id`).all()).toEqual(cases.map(([, title_raw]) => ({ title_raw })))
      for (const [table, index, columns] of [
        ['platform_relation', 'platform_relation_title_query_idx', ['title_raw', 'query_id']],
        ...['apply', 'business', 'recognized'].map(source => [`platform_${source}_projection`, `platform_${source}_projection_title_version_idx`, ['title_raw', 'version_id']]),
      ] as [string, string, string[]][]) {
        expect(sqlite.prepare(`PRAGMA index_list(${table})`).all()).toContainEqual(expect.objectContaining({ name: index }))
        expect((sqlite.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[]).map(row => row.name)).toEqual(columns)
      }
      const after = snapshot(sqlite)
      migrate(db, { migrationsFolder: upgrade })
      expect(snapshot(sqlite)).toEqual(after)
      expect(sqlite.pragma('foreign_key_check')).toEqual([])
    } finally { sqlite.close() }
  })

  it('derives inserted and updated relation titles only from raw_fields for every JSON partition', () => {
    const { sqlite, db } = fixture()
    try {
      const queryId = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'isolated', rdjb: 'query-title', queriedAt: 'frozen' }).returning().get().id
      for (const [index, [raw, expected]] of cases.entries()) {
        sqlite.prepare('INSERT INTO platform_relation(query_id,sequence_no,raw_fields,title_raw,created_at) VALUES(?,?,?,?,?)').run(queryId, index + 1, raw, 'invented', 'frozen')
        const id = Number((sqlite.prepare('SELECT last_insert_rowid() id').get() as { id: number }).id)
        expect(sqlite.prepare('SELECT title_raw FROM platform_relation WHERE id=?').get(id)).toEqual({ title_raw: expected })
        sqlite.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run('{"rdjb":"2"}', id)
        expect(sqlite.prepare('SELECT title_raw FROM platform_relation WHERE id=?').get(id)).toEqual({ title_raw: '2' })
        sqlite.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(raw, id)
        expect(sqlite.prepare('SELECT title_raw,raw_fields FROM platform_relation WHERE id=?').get(id)).toEqual({ title_raw: expected, raw_fields: raw })
      }
    } finally { sqlite.close() }
  })

  it('parses row-owned titles and reuses the same immutable versions while guarding projection drift', () => {
    const { sqlite, db } = fixture()
    try {
      for (const source of ['apply', 'business'] as const) {
        const queryId = db.insert(schema.platformQuery).values({ interface: `${source}_list`, queryKey: source, rdjb: 'query-title', queriedAt: 'frozen' }).returning().get().id
        for (const [index, [raw, expected]] of cases.entries()) {
          let row: unknown
          try { row = JSON.parse(raw) } catch { row = null }
          const parser = source === 'apply' ? parseApplyRecord : parseBusinessProcess
          expect(parser(row).titleRaw).toBe(expected)
          const rawFields = row && typeof row === 'object' && !Array.isArray(row) ? { ...row, id: `${source}-${index}` } : { id: `${source}-${index}` }
          const relation = db.insert(schema.platformRelation).values({ queryId, sequenceNo: index + 1, rawFields }).returning().get()
          const first = ensurePlatformObservation(db, relation.id)
          const before = snapshot(sqlite)
          const second = ensurePlatformObservation(db, relation.id)
          expect(second).toMatchObject({ recordId: first.recordId, versionId: first.versionId, versionCreated: false, observationCreated: false, [`${source}ProjectionReused`]: true })
          expect(snapshot(sqlite)).toEqual(before)
          expect(sqlite.prepare(`SELECT title_raw FROM platform_${source}_projection WHERE version_id=?`).get(first.versionId)).toEqual({ title_raw: expected })
          sqlite.prepare(`UPDATE platform_${source}_projection SET title_raw='drift' WHERE version_id=?`).run(first.versionId)
          expect(() => ensurePlatformObservation(db, relation.id)).toThrow(`${source === 'apply' ? 'Apply' : 'Business'} projection fields differ`)
        }
      }
      expect(sqlite.pragma('foreign_key_check')).toEqual([])
    } finally { sqlite.close() }
  })
})
