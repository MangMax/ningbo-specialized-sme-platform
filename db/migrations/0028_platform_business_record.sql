CREATE TABLE platform_business_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interface TEXT NOT NULL CHECK(interface IN ('business_list','apply_list','recognized_list')),
  platform_key TEXT NOT NULL CHECK(length(trim(platform_key)) > 0),
  identity_rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_business_record_identity_uq ON platform_business_record(interface, platform_key);
--> statement-breakpoint
CREATE TABLE platform_business_record_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES platform_business_record(id) ON DELETE RESTRICT,
  hash_algorithm TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canonical_raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_business_version_hash_uq ON platform_business_record_version(record_id, hash_algorithm, content_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_business_version_owner_uq ON platform_business_record_version(id, record_id);
--> statement-breakpoint
CREATE TABLE platform_business_observation (
  relation_id INTEGER PRIMARY KEY REFERENCES platform_relation(id) ON DELETE RESTRICT,
  record_id INTEGER REFERENCES platform_business_record(id) ON DELETE RESTRICT,
  version_id INTEGER,
  identity_state TEXT NOT NULL,
  content_state TEXT NOT NULL,
  key_source TEXT NOT NULL CHECK(key_source IN ('relation_key','raw_id','both','none')),
  projection_rule_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  batch_id INTEGER REFERENCES import_batch(id) ON DELETE RESTRICT,
  FOREIGN KEY(version_id, record_id) REFERENCES platform_business_record_version(id, record_id) ON DELETE RESTRICT,
  CHECK((identity_state = 'resolved' AND record_id IS NOT NULL) OR (identity_state IN ('missing_key','conflict') AND record_id IS NULL)),
  CHECK((content_state = 'verified' AND version_id IS NOT NULL AND record_id IS NOT NULL) OR (content_state = 'unverifiable' AND version_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX platform_business_observation_record_idx ON platform_business_observation(record_id, version_id, relation_id);
--> statement-breakpoint
CREATE INDEX platform_business_observation_version_idx ON platform_business_observation(version_id, relation_id);
