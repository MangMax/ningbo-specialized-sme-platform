CREATE TABLE file_maintenance_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
 file_id INTEGER NOT NULL REFERENCES stored_file(id),
 revision INTEGER NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('update','remove','restore')),
 idempotency_key TEXT,
 request_hash TEXT NOT NULL,
 mode TEXT NOT NULL CHECK (mode IN ('legacy','versioned')),
 actor TEXT,
 basis TEXT,
 before_json TEXT NOT NULL,
 after_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX file_maintenance_revision_uq ON file_maintenance_audit(file_id, revision);
--> statement-breakpoint
CREATE UNIQUE INDEX file_maintenance_key_uq ON file_maintenance_audit(idempotency_key);
--> statement-breakpoint
CREATE TRIGGER file_maintenance_no_update BEFORE UPDATE ON file_maintenance_audit
BEGIN SELECT RAISE(ABORT, 'file_maintenance_audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER file_maintenance_no_delete BEFORE DELETE ON file_maintenance_audit
BEGIN SELECT RAISE(ABORT, 'file_maintenance_audit is append-only'); END;
