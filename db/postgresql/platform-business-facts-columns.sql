ALTER TABLE platform_collection
  ADD COLUMN IF NOT EXISTS evidence_archive_id bigint,
  ADD COLUMN IF NOT EXISTS evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS evidence_sealed bigint,
  ADD COLUMN IF NOT EXISTS source_archive_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refresh_metadata jsonb;

ALTER TABLE platform_business_observation
  ADD COLUMN IF NOT EXISTS identity_only_source boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_raw_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refresh_facts jsonb;
