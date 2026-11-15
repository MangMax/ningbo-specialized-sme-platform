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

describe('0033 platform apply projection migration', () => {
  it('adds only the apply projection to an existing pre-0033 database and preserves old rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-migration-')); dirs.push(dir)
    const fullMigrations = resolve(import.meta.dirname, '../../../db/migrations')
    const preMigrations = join(dir, 'pre-migrations')
    cpSync(fullMigrations, preMigrations, { recursive: true })
    // Later migrations must also be removed so the pre-state ends exactly before
    // the migration under test; the full set then applies 0033 and everything after.
    rmSync(join(preMigrations, '0033_platform_apply_projection.sql'))
    rmSync(join(preMigrations, '0034_platform_business_projection.sql'))
    rmSync(join(preMigrations, '0035_platform_recognized_projection.sql'))
    const journalPath = join(preMigrations, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 33)
    writeFileSync(journalPath, JSON.stringify(journal))

    const dbPath = join(dir, 'existing.sqlite')
    const sqlite = new Database(dbPath)
    try {
      const db = drizzle(sqlite, { schema })
      migrate(db, { migrationsFolder: preMigrations })
      const enterprise = db.insert(schema.enterprise).values({ name: '既有企业', nameNorm: '既有企业', usccNorm: '91330211255994457P' }).returning().get()
      const query = sqlite.prepare("INSERT INTO platform_query(interface, query_key, queried_at, status, created_at) VALUES('apply_list', 'name:既有企业', '2026-09-01T00:00:00Z', 'success', '2026-09-01T00:00:00Z') RETURNING id").get() as { id: number }
      const originalFields = { id: 'SQ-LEGACY', qymc: '既有企业', sblx: '申请', year: '2024' }
      const relation = sqlite.prepare('INSERT INTO platform_relation(query_id, sequence_no, relation_key, raw_fields, created_at) VALUES(?, 1, ?, ?, ?) RETURNING id').get(query.id, 'SQ-LEGACY', JSON.stringify(originalFields), '2026-09-01T00:00:00Z') as { id: number }
      expect(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='platform_apply_projection'").get()).toEqual({ n: 0 })

      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='platform_apply_projection'").get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM enterprise').get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
      const storedRelation = sqlite.prepare('SELECT relation_key, raw_fields FROM platform_relation WHERE id=?').get(relation.id) as { relation_key: string; raw_fields: string }
      expect(storedRelation.relation_key).toBe('SQ-LEGACY')
      expect(JSON.parse(storedRelation.raw_fields)).toEqual(originalFields)
      expect(sqlite.prepare('SELECT count(*) n FROM platform_apply_projection').get()).toEqual({ n: 0 })
      // Applying the same final migration set again is a journal no-op.
      migrate(db, { migrationsFolder: fullMigrations })
      expect(sqlite.prepare('SELECT count(*) n FROM platform_query').get()).toEqual({ n: 1 })
      expect(enterprise.id).toBeGreaterThan(0)
    } finally { sqlite.close() }
  })
})
