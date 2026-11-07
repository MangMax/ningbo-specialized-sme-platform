CREATE TABLE platform_query_legacy_provenance (
  query_id INTEGER PRIMARY KEY NOT NULL REFERENCES platform_query(id) ON DELETE RESTRICT,
  source_identity TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  collection TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX platform_query_legacy_source_uq ON platform_query_legacy_provenance(source_sha256, segment_index);
