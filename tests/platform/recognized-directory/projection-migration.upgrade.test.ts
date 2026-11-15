import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, describe, expect, it } from 'vitest'
import * as schema from '../../../db/schema'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

function tableExists(sqlite: Database.Database, name: string) {
  return (sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?").get(name) as { n: number }).n === 1
}

describe('0035 platform recognized projection migration', () => {

  it('adds the table to an existing pre-0035 database and preserves old relation/raw rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recognized-migration-existing-')); dirs.push(dir)
    const fullMigrations = resolve(import.meta.dirname, '../../../db/migrations')
    const preMigrations = join(dir, 'pre-migrations')
    cpSync(fullMigrations, preMigrations, { recursive: true })
    rmSync(join(preMigrations, '0035_platform_recognized_projection.sql'))
    const journalPath = join(preMigrations, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 35)
    writeFileSync(journalPath, JSON.stringify(journal))

    const dbPath = join(dir, 'existing.sqlite')
    const sqlite = new Database(dbPath)
    try {
      const db = drizzle(sqlite, { schema })
      migrate(db, { migrationsFolder: preMigrations })
      const enterprise = db.insert(schema.enterprise).values({ name: '既有认定企业', nameNorm: '既有认定企业', usccNorm: '91330211255994457P' }).returning().get()
      // Freeze the actual pre-0035 shape; current ORM inserts include later columns.
      const queryId = Number(sqlite.prepare('INSERT INTO platform_query(interface,query_key,rdjb,queried_at,status,created_at) VALUES(?,?,?,?,?,?)').run('recognized_list', '91330211255994457P', '1,2,3', '2026-09-01T00:00:00Z', 'success', 'original-time').lastInsertRowid)
      const rawFields = { id: 'UUID-LEGACY', qymc: '既有认定企业', rddqrq: '2027-06-30', whpcyear: '2024', whpc: '2', szq: '33020000' }
      const relationId = Number(sqlite.prepare('INSERT INTO platform_relation(query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,?,?,?,?)').run(queryId, 1, 'UUID-LEGACY', JSON.stringify(rawFields), 'original-time').lastInsertRowid)
      expect(tableExists(sqlite, 'platform_recognized_projection')).toBe(false)

      migrate(db, { migrationsFolder: fullMigrations })
      expect(tableExists(sqlite, 'platform_recognized_projection')).toBe(true)
      expect(sqlite.prepare('SELECT count(*) n FROM enterprise').get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
      const stored = sqlite.prepare('SELECT relation_key, raw_fields FROM platform_relation WHERE id=?').get(relationId) as { relation_key: string; raw_fields: string }
      expect(stored.relation_key).toBe('UUID-LEGACY')
      expect(JSON.parse(stored.raw_fields)).toEqual(rawFields)
      expect(enterprise.id).toBeGreaterThan(0)
      expect(sqlite.prepare('SELECT count(*) n FROM platform_recognized_projection').get()).toEqual({ n: 0 })
      expect(sqlite.pragma('foreign_key_check')).toEqual([])
      // The same final migration set applies again as a journal no-op.
      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
    } finally { sqlite.close() }
  })
})


it('0039 leaves existing normalized rows and provenance intact and fidelity unknown until explicit capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recognized-fidelity-migration-')); dirs.push(dir)
  const fullMigrations = resolve(import.meta.dirname, '../../../db/migrations')
  const preMigrations = join(dir, 'pre-migrations')
  cpSync(fullMigrations, preMigrations, {recursive: true})
  const journalPath = join(preMigrations, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  journal.entries = journal.entries.filter((entry: {idx: number}) => entry.idx < 39)
  writeFileSync(journalPath, JSON.stringify(journal))
  const sqlite = new Database(join(dir, 'existing.sqlite'))
  try {
    const db = drizzle(sqlite, {schema})
    migrate(db, {migrationsFolder: preMigrations})
    sqlite.exec(`INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(101,'recognized_list','ORIGINAL','platform-observation-v1','original-time');
      INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(201,101,'platform-row-json-v1','original-hash','{"id":"ORIGINAL"}','original-time');
      INSERT INTO platform_recognized_projection(version_id,record_id,validity_date_raw,maintenance_year,maintenance_batch,rule_version,created_at) VALUES(201,101,'2028-11-20',NULL,'2026-1','platform-recognized-v1','original-time');`)
    const before = sqlite.prepare('SELECT * FROM platform_recognized_projection').get() as object
    const versions = sqlite.prepare('SELECT * FROM platform_business_record_version').all()
    migrate(db, {migrationsFolder: fullMigrations})
    expect(sqlite.prepare('SELECT * FROM platform_recognized_projection').get()).toMatchObject({...before, source_validity_date: null, source_maintenance_batch: null, source_maintenance_year_absent: null})
    expect(sqlite.prepare('SELECT * FROM platform_business_record_version').all()).toEqual(versions.map(row => ({...row as object, canonical_archive_id:null})))
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    migrate(db, {migrationsFolder: fullMigrations})
    expect(sqlite.prepare('SELECT count(*) n FROM platform_recognized_projection').get()).toEqual({n: 1})
    expect(() => sqlite.exec('UPDATE platform_recognized_projection SET source_maintenance_year_absent=2')).toThrow()
  } finally {sqlite.close()}
})
