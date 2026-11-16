import type Database from 'better-sqlite3';
/** Additive, transactional upgrade for existing native databases; no historical facts rewritten. */
export function upgradeTitleCycleDisposition(db: Database.Database) {
    db.transaction(() => db.exec(`
 CREATE TABLE IF NOT EXISTS title_cycle_disposition_revision (
 revision_id INTEGER PRIMARY KEY, id TEXT NOT NULL, revision INTEGER NOT NULL,
 enterprise_id INTEGER NOT NULL REFERENCES enterprise(id), title_code TEXT NOT NULL CHECK(title_code='little_giant'),
 cycle_event_id INTEGER REFERENCES record_event(id), status TEXT NOT NULL CHECK(status IN ('pending','confirmed','replaced','withdrawn')),
 kind TEXT NOT NULL CHECK(kind IN ('not_applied','not_recommended','formal_failure')),
 source_file_id INTEGER NOT NULL REFERENCES stored_file(id), source_sha256 TEXT NOT NULL,
 cycle_revision INTEGER, effective_precision TEXT NOT NULL, effective_value TEXT,
 fact TEXT NOT NULL, audit TEXT NOT NULL, UNIQUE(id,revision));
 CREATE INDEX IF NOT EXISTS title_cycle_disposition_scope ON title_cycle_disposition_revision(enterprise_id,title_code,cycle_event_id,id,revision);
 CREATE INDEX IF NOT EXISTS title_cycle_disposition_source ON title_cycle_disposition_revision(source_file_id,source_sha256);
 CREATE TABLE IF NOT EXISTS title_cycle_disposition_receipt (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, receipt TEXT NOT NULL);
 `)).immediate();
}
