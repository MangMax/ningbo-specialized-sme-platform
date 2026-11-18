import type Database from 'better-sqlite3'
import { assertRosterFileClassificationSchema } from '../db/schema-phase'

/** Run only against an offline, backed-up copy. Keep the parent name stable so
 * child foreign keys and their rows survive the SQLite table rebuild. */
export function upgradeRosterFileClassification(sqlite: Database.Database) {
  if (sqlite.inTransaction) throw new Error('File classification upgrade requires its own transaction')
  const foreignKeys = sqlite.pragma('foreign_keys', { simple: true })
  sqlite.pragma('foreign_keys = OFF')
  try {
    return sqlite.transaction(() => {
      if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='roster_file_classification'").get()) {
        assertRosterFileClassificationSchema(sqlite)
        return { migrated: false }
      }
      sqlite.exec(`
        CREATE TABLE roster_file_classification (
          file_id INTEGER PRIMARY KEY NOT NULL REFERENCES stored_file(id) ON DELETE CASCADE,
          source TEXT,
          kind TEXT,
          year INTEGER,
          batch INTEGER,
          title_code TEXT REFERENCES title(code),
          category_state TEXT NOT NULL DEFAULT 'unset',
          parse_state TEXT NOT NULL DEFAULT 'unparsed'
        );
        INSERT INTO roster_file_classification (file_id, source, kind, year, batch, title_code, category_state, parse_state)
          SELECT id, source, kind, year, batch, title_code, category_state, parse_state FROM stored_file;

        CREATE TABLE stored_file_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          rel_path TEXT NOT NULL,
          display_name TEXT,
          filename TEXT NOT NULL,
          ext TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          removed_at TEXT
        );
        INSERT INTO stored_file_new (id, rel_path, display_name, filename, ext, bytes, sha256, created_at, removed_at)
          SELECT id, rel_path, display_name, filename, ext, bytes, sha256, created_at, removed_at FROM stored_file;

        DELETE FROM sqlite_sequence WHERE name = 'stored_file_new';
        INSERT INTO sqlite_sequence (name, seq)
          SELECT 'stored_file_new', seq FROM sqlite_sequence WHERE name = 'stored_file';

        DROP TABLE stored_file;
        ALTER TABLE stored_file_new RENAME TO stored_file;
        CREATE UNIQUE INDEX stored_file_rel_path_uq ON stored_file (rel_path);
        CREATE INDEX roster_file_classification_source_idx ON roster_file_classification (source);
        CREATE INDEX roster_file_classification_category_state_idx ON roster_file_classification (category_state);
        CREATE INDEX roster_file_classification_parse_state_idx ON roster_file_classification (parse_state);
      `)
      assertRosterFileClassificationSchema(sqlite)
      if (sqlite.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('File classification upgrade foreign key conflict')
      }
      return { migrated: true }
    }).immediate()
  } finally {
    sqlite.pragma(`foreign_keys = ${foreignKeys}`)
  }
}
