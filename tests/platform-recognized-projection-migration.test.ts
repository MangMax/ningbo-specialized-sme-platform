import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

const COLUMNS = [
  'version_id', 'record_id', 'validity_date_raw', 'maintenance_year', 'maintenance_batch',
  'district', 'award_note', 'title_raw', 'name_raw', 'uscc_raw', 'rule_version', 'created_at',
  'source_validity_date', 'source_maintenance_batch', 'source_maintenance_year_absent',
]
const INDEXES = [
  { name: 'platform_recognized_projection_batch_idx' },
  { name: 'platform_recognized_projection_district_idx' },
  { name: 'platform_recognized_projection_record_idx' },
  { name: 'platform_recognized_projection_title_idx' },
  { name: 'platform_recognized_projection_uscc_idx' },
  { name: 'platform_recognized_projection_validity_idx' },
  { name: 'platform_recognized_projection_year_idx' },
]

function tableExists(sqlite: Database.Database, name: string) {
  return (sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?").get(name) as { n: number }).n === 1
}

describe('0035 platform recognized projection migration', () => {
  it('applies idempotently from an empty database and adds only the recognized table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recognized-migration-empty-')); dirs.push(dir)
    const fullMigrations = resolve(import.meta.dirname, '../db/migrations')
    const sqlite = new Database(join(dir, 'empty.sqlite'))
    try {
      const db = drizzle(sqlite, { schema })
      expect(tableExists(sqlite, 'platform_recognized_projection')).toBe(false)
      migrate(db, { migrationsFolder: fullMigrations })
      expect(tableExists(sqlite, 'platform_recognized_projection')).toBe(true)
      expect((sqlite.prepare('PRAGMA table_info(platform_recognized_projection)').all() as { name: string }[]).map(column => column.name)).toEqual(COLUMNS)
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='platform_recognized_projection' ORDER BY name").all()).toEqual(INDEXES)
      expect(sqlite.pragma('foreign_key_check')).toEqual([])
      // Re-applying the same journal is a no-op, not a duplicate-table failure.
      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_recognized_projection').get()).toEqual({ n: 0 })
    } finally { sqlite.close() }
  })

  it('adds the table to an existing pre-0035 database and preserves old relation/raw rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recognized-migration-existing-')); dirs.push(dir)
    const fullMigrations = resolve(import.meta.dirname, '../db/migrations')
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
      const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: '91330211255994457P', rdjb: '1,2,3', queriedAt: '2026-09-01T00:00:00Z', status: 'success' }).returning().get()
      const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: 'UUID-LEGACY', rawFields: { id: 'UUID-LEGACY', qymc: '既有认定企业', rddqrq: '2027-06-30', whpcyear: '2024', whpc: '2', szq: '33020000' } }).returning().get()
      expect(tableExists(sqlite, 'platform_recognized_projection')).toBe(false)

      migrate(db, { migrationsFolder: fullMigrations })
      expect(tableExists(sqlite, 'platform_recognized_projection')).toBe(true)
      expect(sqlite.prepare('SELECT count(*) n FROM enterprise').get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
      const stored = sqlite.prepare('SELECT relation_key, raw_fields FROM platform_relation WHERE id=?').get(relation.id) as { relation_key: string; raw_fields: string }
      expect(stored.relation_key).toBe('UUID-LEGACY')
      expect(JSON.parse(stored.raw_fields)).toEqual(relation.rawFields)
      expect(enterprise.id).toBeGreaterThan(0)
      expect(sqlite.prepare('SELECT count(*) n FROM platform_recognized_projection').get()).toEqual({ n: 0 })
      expect((sqlite.prepare('PRAGMA table_info(platform_recognized_projection)').all() as { name: string }[]).map(column => column.name)).toEqual(COLUMNS)
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='platform_recognized_projection' ORDER BY name").all()).toEqual(INDEXES)
      expect(sqlite.pragma('foreign_key_check')).toEqual([])
      // The same final migration set applies again as a journal no-op.
      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
    } finally { sqlite.close() }
  })
})


it('0039 leaves existing normalized rows and provenance intact and fidelity unknown until explicit capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recognized-fidelity-migration-')); dirs.push(dir)
  const fullMigrations = resolve(import.meta.dirname, '../db/migrations')
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
    expect(sqlite.prepare('SELECT * FROM platform_recognized_projection').get()).toEqual({...before, source_validity_date: null, source_maintenance_batch: null, source_maintenance_year_absent: null})
    expect(sqlite.prepare('SELECT * FROM platform_business_record_version').all()).toEqual(versions)
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    migrate(db, {migrationsFolder: fullMigrations})
    expect(sqlite.prepare('SELECT count(*) n FROM platform_recognized_projection').get()).toEqual({n: 1})
    expect(() => sqlite.exec('UPDATE platform_recognized_projection SET source_maintenance_year_absent=2')).toThrow()
  } finally {sqlite.close()}
})
