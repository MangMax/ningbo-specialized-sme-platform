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

describe('0034 platform business projection migration', () => {
  it('adds only the business projection to an existing pre-0034 database and preserves old rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'business-projection-migration-')); dirs.push(dir)
    const fullMigrations = resolve(import.meta.dirname, '../db/migrations')
    const preMigrations = join(dir, 'pre-migrations')
    cpSync(fullMigrations, preMigrations, { recursive: true })
    rmSync(join(preMigrations, '0034_platform_business_projection.sql'))
    const journalPath = join(preMigrations, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== '0034_platform_business_projection')
    writeFileSync(journalPath, JSON.stringify(journal))

    const dbPath = join(dir, 'existing.sqlite')
    const sqlite = new Database(dbPath)
    try {
      const db = drizzle(sqlite, { schema })
      migrate(db, { migrationsFolder: preMigrations })
      const enterprise = db.insert(schema.enterprise).values({ name: '既有企业', nameNorm: '既有企业', usccNorm: '91330211255994457P' }).returning().get()
      const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: '91330211255994457P', rdjb: '2', queriedAt: '2026-09-01T00:00:00Z', status: 'success' }).returning().get()
      const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: 'SQ-LEGACY-B', rawFields: { id: 'SQ-LEGACY-B', qymc: '既有企业', sblx: '复核', whpc: '2025-1', personuuid: '第四批' } }).returning().get()
      expect(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='platform_business_projection'").get()).toEqual({ n: 0 })

      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='platform_business_projection'").get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM enterprise').get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
      const storedRelation = sqlite.prepare('SELECT relation_key, raw_fields FROM platform_relation WHERE id=?').get(relation.id) as { relation_key: string; raw_fields: string }
      expect(storedRelation.relation_key).toBe('SQ-LEGACY-B')
      expect(JSON.parse(storedRelation.raw_fields)).toEqual(relation.rawFields)
      expect(sqlite.prepare('SELECT count(*) n FROM platform_business_projection').get()).toEqual({ n: 0 })
      expect(sqlite.prepare('PRAGMA table_info(platform_business_projection)').all().map((column: { name: string }) => column.name)).toEqual([
        'version_id', 'record_id', 'declare_kind', 'business_year', 'applied_at', 'status', 'batch', 'award_batch_label', 'province', 'name_raw', 'uscc_raw', 'rule_version', 'created_at',
      ])
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='platform_business_projection' ORDER BY name").all()).toEqual([
        { name: 'platform_business_projection_applied_idx' },
        { name: 'platform_business_projection_batch_idx' },
        { name: 'platform_business_projection_kind_idx' },
        { name: 'platform_business_projection_record_idx' },
        { name: 'platform_business_projection_status_idx' },
        { name: 'platform_business_projection_uscc_idx' },
        { name: 'platform_business_projection_year_idx' },
      ])
      // Applying the same final migration set again is a journal no-op.
      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
      expect(enterprise.id).toBeGreaterThan(0)
    } finally { sqlite.close() }
  })
})
