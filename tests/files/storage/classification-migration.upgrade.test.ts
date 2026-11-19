import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import { upgradeRosterFileClassification } from '../../../upgrade/roster-file-classification'

function historicalDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder: new URL('../../../db/migrations', import.meta.url).pathname })
  sqlite.exec(`
    INSERT INTO title (code, name_zh, level, rank) VALUES ('little_giant', '小巨人', 'national', 1);
    INSERT INTO stored_file
      (id, rel_path, filename, ext, bytes, sha256, source, kind, year, batch, title_code, category_state, parse_state, created_at, display_name, removed_at)
    VALUES
      (2, 'notice.pdf', 'notice.pdf', 'pdf', 82, 'notice-bytes', 'jxj', 'announcement', 2024, 2, 'little_giant', 'set', 'parsed', 'created-notice', '名单', NULL),
      (5, 'export.xlsx', 'export.xlsx', 'xlsx', 37, 'export-bytes', 'miit', 'export', NULL, NULL, NULL, 'inferred', 'failed', 'created-export', NULL, 'removed-export'),
      (9, 'upload.pdf', 'upload.pdf', 'pdf', 15, 'upload-bytes', NULL, NULL, NULL, NULL, NULL, 'unset', 'unparsed', 'created-upload', NULL, NULL),
      (50, 'deleted.pdf', 'deleted.pdf', 'pdf', 1, 'deleted-bytes', NULL, NULL, NULL, NULL, NULL, 'unset', 'unparsed', 'created-deleted', NULL, NULL);
    DELETE FROM stored_file WHERE id = 50;
    INSERT INTO stored_file_part (file_id, title_code, event_kind, row_count) VALUES (2, 'little_giant', 'award', 7);
    INSERT INTO ocr_result (file_id, page_no, markdown, channel, created_at) VALUES (2, 1, '原文', 'ocr', 'created-ocr');
    INSERT INTO stored_file_audit (stored_file_id, old_display_name, new_display_name, created_at) VALUES (2, 'notice.pdf', '名单', 'renamed');
  `)
  return sqlite
}

it('moves all classifications while preserving file identity, dependents and the next ID', () => {
  const sqlite = historicalDb()
  try {
    const columns = 'id, rel_path, filename, ext, bytes, sha256, created_at, display_name, removed_at'
    const files = sqlite.prepare(`SELECT ${columns} FROM stored_file ORDER BY id`).all()
    upgradeRosterFileClassification(sqlite)
    expect(sqlite.prepare('SELECT * FROM roster_file_classification ORDER BY file_id').raw().all()).toEqual([
      [2, 'jxj', 'announcement', 2024, 2, 'little_giant', 'set', 'parsed'],
      [5, 'miit', 'export', null, null, null, 'inferred', 'failed'],
      [9, null, null, null, null, null, 'unset', 'unparsed'],
    ])
    expect(sqlite.prepare('SELECT name FROM pragma_table_info(\'stored_file\')').pluck().all().sort()).toEqual(columns.split(', ').sort())
    expect(sqlite.prepare(`SELECT ${columns} FROM stored_file ORDER BY id`).all()).toEqual(files)
    expect(sqlite.prepare('SELECT file_id, row_count FROM stored_file_part').raw().all()).toEqual([[2, 7]])
    expect(sqlite.prepare('SELECT file_id, markdown FROM ocr_result').raw().all()).toEqual([[2, '原文']])
    expect(sqlite.prepare('SELECT stored_file_id, new_display_name FROM stored_file_audit').raw().all()).toEqual([[2, '名单']])
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(sqlite.prepare("INSERT INTO stored_file (rel_path, filename, ext, bytes, sha256, created_at) VALUES ('next', 'next', '', 0, 'next', 'next')").run().lastInsertRowid).toBe(51)
  } finally {
    sqlite.close()
  }
})

it('rolls back the classification and parent table together if final foreign keys fail', () => {
  const sqlite = historicalDb()
  try {
    sqlite.pragma('foreign_keys = OFF')
    sqlite.exec("UPDATE stored_file SET title_code = 'missing-title' WHERE id = 2")
    sqlite.pragma('foreign_keys = ON')

    expect(() => upgradeRosterFileClassification(sqlite)).toThrow('File classification upgrade foreign key conflict')
    expect(sqlite.prepare('SELECT title_code FROM stored_file WHERE id = 2').pluck().get()).toBe('missing-title')
    expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name IN ('roster_file_classification', 'stored_file_new')").all()).toEqual([])
    expect(sqlite.prepare('SELECT file_id FROM stored_file_part').pluck().all()).toEqual([2])
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)

    sqlite.exec("UPDATE stored_file SET title_code = 'little_giant' WHERE id = 2")
    expect(upgradeRosterFileClassification(sqlite)).toEqual({ migrated: true })
    expect(upgradeRosterFileClassification(sqlite)).toEqual({ migrated: false })
  } finally {
    sqlite.close()
  }
})
