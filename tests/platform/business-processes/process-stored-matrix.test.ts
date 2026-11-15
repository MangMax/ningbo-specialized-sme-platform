/** #734 A preimplementation literal oracles. These are not capture/reader acceptance. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import * as schema from '../../../upgrade/legacy-schema'
import { legacyRawRdjb } from '../../../upgrade/frozen/server/platform-legacy-relation-read'
import { legacyRowTitle } from '../../../lib/platform/observation-facts'
import { parseBusinessProcess } from '../../../lib/platform/business-projection'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import { listPlatformBusinessProcesses } from '../../../upgrade/frozen/server/platform-business-processes'
import { readPlatformFilterOptions } from '../../../upgrade/frozen/server/platform-filter-options'
import { rowSnapshot } from '../../../lib/platform/sqlite-row-cells'
import { candidateFixture } from '../../helpers/candidate-scope-target'

const fields = ['title_raw', 'declare_kind', 'year', 'status', 'batch', 'applied_at', 'award_batch_label', 'province'] as const
function fixture() {
  const base = process.env.PROCESS_STORED_EVIDENCE_DIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const d = statfsSync(base)
  if (d.bavail * d.bsize < 8 * 1024 ** 3) throw new Error('Disk floor 8GiB')
  const root = mkdtempSync(join(base, 'matrix-'))
  const t = new Database(join(root, 'legacy.sqlite'))
  const db = drizzle(t, { schema })
  migrate(db, { migrationsFolder: 'db/migrations' })
  t.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','Q','2','t','success','c')")
  return { root, t, db }
}

it('freezes all eight original process cells after old SQLite affinities including REAL year and irreversible driver values', () => {
  const { root, t, db } = fixture()
  try {
    const inputs = [
      ['NULL', 'null', 'null', ''], ["''", 'text', 'text', ''], ["' '", 'text', 'text', '20'],
      ["' pending '", 'text', 'text', '2070656E64696E6720'],
      ['2024', 'text', 'integer', '32303234'], ['2024.5', 'text', 'real', '323032342E35'],
      ["'2024'", 'text', 'integer', '32303234'], ['2024.0', 'text', 'integer', '32303234'],
      ["'bad'", 'text', 'text', '626164'], ["X'32303234'", 'blob', 'blob', '32303234'],
      ["X''", 'blob', 'blob', ''], ['0', 'text', 'integer', '30'], ['-1', 'text', 'integer', '2D31'],
      ["CAST(X'610062' AS TEXT)", 'text', 'text', '610062'],
      ["CAST(X'FF' AS TEXT)", 'text', 'text', 'FF'],
      ['9007199254740993', 'text', 'integer', '39303037313939323534373430393933'],
    ] as const
    const actual = inputs.map(([expression, textKind, yearKind, hex], i) => {
      const id = i + 1
      t.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(?,1,?,'{}','c')").run(id, id)
      ensurePlatformObservation(db, id)
      t.exec(`UPDATE platform_relation SET ${fields.map(f => `${f}=${expression}`).join(',')} WHERE id=${id}`)
      const cells = rowSnapshot(t, 'platform_relation', 'id', id, [...fields])
      expect(cells.map(c => c.storageClass)).toEqual(fields.map(f => f === 'year' ? yearKind : textKind))
      expect(cells.map(c => c.hex)).toEqual(fields.map(f => i === 7 && f !== 'year' ? '323032342E30' : hex))
      if (i === 5) expect(cells[2]).toEqual({ name: 'year', storageClass: 'real', hex, real64be: '409fa20000000000' })
      return { id, expression, cells }
    })
    const rows = listPlatformBusinessProcesses({ view: 'isolated', pageSize: 200 }, db)
    const values = rows.rows.map(r => { if (r.kind !== 'observation') throw new Error('Wrong view'); return { id: r.relationId, value: r.businessYear } })
    expect(values.find(r => r.id === 6)?.value).toBe(2024.5)
    expect(values.find(r => r.id === 10)?.value).toEqual(Buffer.from('2024'))
    expect(values.find(r => r.id === 16)?.value).toBe(9007199254740992)
    expect(rows.total).toBe(16)
    expect(readPlatformFilterOptions({ source: 'business-processes', view: 'isolated' }, db).years).toEqual([2024])
    expect(listPlatformBusinessProcesses({ view: 'isolated', year: 2024 }, db).total).toBe(3)
    writeFileSync(join(root, 'STORAGE-MATRIX.json'), JSON.stringify({ actual, values, rows }, null, 2))
  } finally { t.close() }
})

it('freezes independent SQL fact-title and stored title for duplicate keys and raw value kinds', () => {
  const { root, t, db } = fixture()
  try {
    const cases = [
      ['{"rdjb":"2","rdjb":"3"}', '2', '3'],
      ['{"rdjb":"1","rdjb":"3"}', '1', '3'],
      ['{"rdjb":"3","rdjb":"2"}', '3', '2'],
      ['{"rdjb":2,"rdjb":"3"}', null, '3'],
      ['{"rdjb":"2","rdjb":false}', '2', null],
      ['{"rd\\u006ab":"2","rdjb":"3"}', '2', '3'],
      ['{"rdjb":"3","rd\\u006ab":"2"}', '3', '2'],
      ['[{"rdjb":"2"}]', null, null], ['invalid', null, null], [null, null, null],
      ['{"rdjb":" \\t2 \\n"}', '2', '2'], ['{"rdjb":" \\t "}', null, null],
      ['{"rdjb":null}', null, null], ['{"rdjb":true}', null, null],
      ['{"rdjb":2}', null, null], ['{"rdjb":["2"]}', null, null],
      ['{"rdjb":{"value":"2"}}', null, null], ['{}', null, null],
    ] as const
    const results = cases.map(([raw, expectedSql, expectedParsed], i) => {
      const id = i + 1
      db.insert(schema.platformRelation).values({ id, queryId: 1, sequenceNo: id }).run()
      t.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run(raw, id)
      t.prepare("UPDATE platform_relation SET title_raw='X' WHERE id=?").run(id)
      const old = db.select({ raw: legacyRawRdjb }).from(schema.platformRelation).where(eq(schema.platformRelation.id, id)).get()!
      const oldTitle = legacyRowTitle({ rdjb: old.raw })
      let parsed: unknown = null
      try { parsed = raw === null ? null : JSON.parse(raw) } catch { /* The old SQL rejects invalid JSON. */ }
      const sourceTitle = parseBusinessProcess(parsed).titleRaw
      expect(oldTitle).toBe(expectedSql)
      expect(sourceTitle).toBe(expectedParsed)
      const cell = rowSnapshot(t, 'platform_relation', 'id', id, ['title_raw'])[0]
      expect(cell).toEqual({ name: 'title_raw', storageClass: 'text', hex: '58' })
      return { raw, oldTitle, sourceTitle, exactStoredTitle: 'X' }
    })
    writeFileSync(join(root, 'SQL-TITLE-MATRIX.json'), JSON.stringify(results, null, 2))
  } finally { t.close() }
})

it('retains the actual historical REAL-year full-migration rejection without modifying T05b', async () => {
  let failure = ''
  try {
    await candidateFixture(source => {
      source.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','Q','2','t','success','c'); INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(1,1,1,'{}','c')")
      ensurePlatformObservation(drizzle(source, { schema }), 1)
      source.exec('UPDATE platform_relation SET year=2024.5 WHERE id=1')
    })
  } catch (error) { failure = String(error) }
  expect(failure).toContain('Unrepresentable legacy process year')
  writeFileSync(join(process.env.PROCESS_STORED_EVIDENCE_DIR ?? tmpdir(), 'REAL-YEAR-REJECTION.json'), JSON.stringify({ input: 2024.5, failure, fullMigrationSupported: false }, null, 2))
})
