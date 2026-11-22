\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

\ir ../../db/postgresql/platform-projection-owner.sql

DROP TRIGGER IF EXISTS platform_version_canonical_archive ON platform_business_record_version;
DROP TRIGGER IF EXISTS platform_version_canonical_archive_required ON platform_business_record_version;
DROP FUNCTION IF EXISTS guard_platform_canonical_archive();
DROP FUNCTION IF EXISTS platform_observation_snapshot(bigint, bytea);

ALTER TABLE platform_apply_projection DROP CONSTRAINT IF EXISTS platform_apply_projection_source_archive_id_fkey;
ALTER TABLE platform_business_observation DROP CONSTRAINT IF EXISTS platform_business_observation_candidate_scope_archive_id_fkey;
ALTER TABLE platform_business_observation DROP CONSTRAINT IF EXISTS platform_business_observation_witness_archive_id_fkey;
ALTER TABLE platform_business_projection DROP CONSTRAINT IF EXISTS platform_business_projection_source_archive_id_fkey;
ALTER TABLE platform_business_record_version DROP CONSTRAINT IF EXISTS platform_business_record_version_canonical_archive_id_fkey;
ALTER TABLE platform_collection DROP CONSTRAINT IF EXISTS platform_collection_reconcile_slot_raw_archive_id_fkey;
ALTER TABLE platform_collection DROP CONSTRAINT IF EXISTS platform_collection_witness_archive_id_fkey;
ALTER TABLE platform_recognized_projection DROP CONSTRAINT IF EXISTS platform_recognized_projection_exact_title_archive_id_fkey;
ALTER TABLE platform_recognized_projection DROP CONSTRAINT IF EXISTS platform_recognized_projection_source_archive_id_fkey;

ALTER TABLE platform_business_record_version DROP COLUMN IF EXISTS canonical_archive_id,
  DROP COLUMN IF EXISTS canonical_raw_json;
ALTER TABLE platform_collection DROP COLUMN IF EXISTS reconcile_slot_state,
  DROP COLUMN IF EXISTS reconcile_slot_rule,
  DROP COLUMN IF EXISTS reconcile_slot_raw_archive_id,
  DROP COLUMN IF EXISTS reconcile_slot_row_count,
  DROP COLUMN IF EXISTS reconcile_slot_input_sha256,
  DROP COLUMN IF EXISTS reconcile_slot_reason;

DROP TABLE IF EXISTS platform_collection_archive_ref,
  platform_observation_archive_ref,
  platform_version_archive_ref,
  platform_observation_fingerprint_basis,
  platform_collection_legacy_provenance,
  platform_archive_value;
DROP FUNCTION IF EXISTS guard_platform_archive_binding();
COMMIT;
