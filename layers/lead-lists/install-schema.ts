import type Database from 'better-sqlite3'

export function installLeadListSchema(db: Database.Database) {
  db.exec(`
    INSERT INTO enterprise_source_channel (code, name) VALUES ('research', '调研走访') ON CONFLICT DO NOTHING;
    INSERT INTO enterprise_source_list_type (code, name) VALUES ('lead', '线索名单') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS lead_list_version (
      id INTEGER PRIMARY KEY,
      series TEXT NOT NULL,
      channel_code TEXT NOT NULL REFERENCES enterprise_source_channel(code),
      list_type_code TEXT NOT NULL REFERENCES enterprise_source_list_type(code),
      acquired_on TEXT NOT NULL,
      file_id INTEGER NOT NULL REFERENCES stored_file(id),
      file_sha256 TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (series, channel_code, list_type_code, acquired_on, file_id)
    );
    CREATE INDEX IF NOT EXISTS lead_list_version_file_idx ON lead_list_version(file_id);
    CREATE TABLE IF NOT EXISTS lead_list_row (
      id INTEGER PRIMARY KEY,
      version_id INTEGER NOT NULL REFERENCES lead_list_version(id),
      row_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      uscc TEXT,
      district TEXT,
      note TEXT,
      enterprise_id INTEGER REFERENCES enterprise(id),
      review_hash TEXT,
      review_actor TEXT,
      review_basis TEXT,
      reviewed_at TEXT,
      CHECK ((enterprise_id IS NULL) = (review_hash IS NULL)),
      UNIQUE (version_id, row_number)
    );
  `)
}

export function leadListSchemaPresent(db: Database.Database) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lead_list_row'").get())
}
