CREATE TABLE evidence_review_receipt_114 (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 idempotency_key TEXT NOT NULL UNIQUE,
 request_hash TEXT NOT NULL,
 kind TEXT NOT NULL,
 enterprise_id INTEGER,
 title_code TEXT,
 direction TEXT,
 decision_id INTEGER,
 source_decision_id INTEGER,
 reviewed_revision_id INTEGER,
 actor TEXT NOT NULL,
 basis TEXT NOT NULL,
 response TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX evidence_review_scope_114_idx ON evidence_review_receipt_114(enterprise_id,title_code,direction,decision_id,id);
--> statement-breakpoint
CREATE TABLE evidence_rule_release_114 (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 rule_id TEXT NOT NULL,
 version TEXT NOT NULL,
 enterprise_id INTEGER NOT NULL,
 title_code TEXT NOT NULL,
 direction TEXT NOT NULL,
 previous_digest TEXT NOT NULL,
 evaluation_digest TEXT NOT NULL,
 revision_id INTEGER,
 receipt_key TEXT NOT NULL,
 UNIQUE(rule_id,version,enterprise_id,title_code,direction)
);
