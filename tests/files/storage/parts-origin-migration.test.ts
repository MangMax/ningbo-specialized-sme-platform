import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { backfillFileParts } from '../../../server/utils/file-parts'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsFolder = join(appRoot, 'db/migrations')

it('0006 保留来源未知的旧行,并对含 NULL 坐标施加唯一约束', () => {
  const root = mkdtempSync(join(tmpdir(), 'spztx-parts-origin-migration-'))
  const legacyMigrations = join(root, 'migrations-0000-0005')
  const sqlite = new Database(join(root, 'migration.db'))
  try {
    cpSync(migrationsFolder, legacyMigrations, { recursive: true })
    rmSync(join(legacyMigrations, '0006_parts_origin.sql'), { force: true })
    rmSync(join(legacyMigrations, 'meta/0006_snapshot.json'), { force: true })
    const journalPath = join(legacyMigrations, 'meta/_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number }>
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 5)
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)

    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: legacyMigrations })

    sqlite
      .prepare('INSERT INTO title (code, name_zh, level, rank) VALUES (?, ?, ?, ?)')
      .run('specialized_sme', '专精特新中小企业', 'national', 2)

    const insertFile = sqlite.prepare(
      `INSERT INTO stored_file (rel_path, filename, ext, bytes, sha256, parse_state, created_at)
       VALUES (?, ?, 'pdf', 1, ?, ?, '2026-10-14T00:00:00.000Z')`,
    )
    const parsedFileId = Number(
      insertFile.run('parsed.pdf', 'parsed.pdf', 'a'.repeat(64), 'parsed').lastInsertRowid,
    )
    const unparsedFileId = Number(
      insertFile.run('unparsed.pdf', 'unparsed.pdf', 'b'.repeat(64), 'unparsed').lastInsertRowid,
    )
    const insertLegacyPart = sqlite.prepare(
      `INSERT INTO stored_file_part
       (file_id, title_code, event_kind, year, batch, attachment, row_count)
       VALUES (?, 'specialized_sme', 'award', ?, ?, ?, ?)`,
    )
    insertLegacyPart.run(parsedFileId, null, null, null, 7)
    insertLegacyPart.run(unparsedFileId, null, null, null, 9)

    migrate(db, { migrationsFolder })

    const rows = sqlite
      .prepare(
        `SELECT file_id AS fileId, year, batch, attachment, row_count AS rowCount,
                origin, has_conflict AS hasConflict
         FROM stored_file_part ORDER BY file_id`,
      )
      .all() as Array<{
      fileId: number
      year: number | null
      batch: number | null
      attachment: string | null
      rowCount: number
      origin: string
      hasConflict: number
    }>
    expect(rows).toEqual([
      {
        fileId: parsedFileId,
        year: null,
        batch: null,
        attachment: null,
        rowCount: 7,
        origin: 'legacy',
        hasConflict: 0,
      },
      {
        fileId: unparsedFileId,
        year: null,
        batch: null,
        attachment: null,
        rowCount: 9,
        origin: 'legacy',
        hasConflict: 0,
      },
    ])

    backfillFileParts(db)
    expect(
      sqlite
        .prepare('SELECT origin FROM stored_file_part ORDER BY file_id')
        .all(),
    ).toEqual([{ origin: 'legacy' }, { origin: 'legacy' }])

    const duplicateNullCoordinate = sqlite.prepare(
      `INSERT INTO stored_file_part
       (file_id, title_code, event_kind, year, batch, attachment, row_count)
       VALUES (?, 'specialized_sme', 'award', NULL, NULL, NULL, 1)`,
    )
    expect(() => duplicateNullCoordinate.run(parsedFileId)).toThrow()
    expect(() => duplicateNullCoordinate.run(unparsedFileId)).toThrow()
    sqlite
      .prepare(
        `INSERT INTO stored_file_part
         (file_id, title_code, event_kind, year, batch, attachment, row_count)
         VALUES (?, 'specialized_sme', 'award', 2024, NULL, NULL, 1)`,
      )
      .run(parsedFileId)
  } finally {
    sqlite.close()
    rmSync(root, { recursive: true, force: true })
  }
})
