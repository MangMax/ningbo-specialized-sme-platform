CREATE TABLE file_physical_intent (
 id TEXT PRIMARY KEY NOT NULL,
 file_id INTEGER NOT NULL REFERENCES stored_file(id),
 rel_path TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','quarantined','recovering','recovered')),
 delete_key TEXT NOT NULL,
 delete_hash TEXT NOT NULL,
 delete_receipt TEXT,
 recover_key TEXT,
 recover_hash TEXT,
 recover_receipt TEXT,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX file_physical_active_uq ON file_physical_intent(file_id) WHERE state != 'recovered';
--> statement-breakpoint
CREATE UNIQUE INDEX file_physical_delete_key_uq ON file_physical_intent(delete_key);
--> statement-breakpoint
CREATE UNIQUE INDEX file_physical_recover_key_uq ON file_physical_intent(recover_key);
--> statement-breakpoint
CREATE INDEX file_physical_history_idx ON file_physical_intent(file_id, created_at, id);
