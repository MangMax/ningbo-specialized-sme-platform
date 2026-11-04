CREATE TABLE enterprise_fact_revision (
 id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
 enterprise_id INTEGER NOT NULL REFERENCES enterprise(id),
 fact_id INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','confirmed','replaced','withdrawn')),
 fact TEXT NOT NULL,
 replaces INTEGER,
 action TEXT NOT NULL,
 actor TEXT NOT NULL,
 basis TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX enterprise_fact_revision_key ON enterprise_fact_revision(enterprise_id,fact_id,revision);
--> statement-breakpoint
CREATE TABLE enterprise_fact_receipt (
 idempotency_key TEXT PRIMARY KEY NOT NULL,
 request_hash TEXT NOT NULL,
 receipt TEXT NOT NULL
);
