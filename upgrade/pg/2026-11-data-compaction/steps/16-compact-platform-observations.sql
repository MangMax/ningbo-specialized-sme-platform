\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

SELECT EXISTS (
  SELECT FROM pg_attribute
  WHERE attrelid = 'platform_business_observation'::regclass AND attname = 'relation_facts' AND NOT attisdropped
) AS needs_observation_compaction
\gset
\if :needs_observation_compaction
\ir support/compact-platform-source-values.sql
\ir support/compact-recognized-source-scope.sql
\ir support/verify-platform-source-comparison.sql

DROP TRIGGER platform_collection_witness_fixed ON platform_collection;
DROP TRIGGER platform_observation_witness_fixed ON platform_business_observation;
DROP TRIGGER platform_recognized_exact_title_fixed ON platform_recognized_projection;
\ir ../../../../db/postgresql/platform-collection-scope-integrity.sql
\ir ../../../../db/postgresql/platform-observation-source.sql
\ir ../../../../db/postgresql/platform-projection-owner.sql

UPDATE platform_collection SET condition_facts = condition_facts - 'witnesses' WHERE condition_facts ? 'witnesses';
ALTER TABLE platform_collection RENAME COLUMN source_archive_bytes TO source_bytes;

ALTER TABLE platform_collection
  DROP COLUMN evidence_archive_id,
  DROP COLUMN evidence_sealed,
  DROP COLUMN witness_gate,
  DROP COLUMN witness_rule,
  DROP COLUMN witness_archive_id,
  DROP COLUMN witness_sha256,
  DROP COLUMN witness_error_name,
  DROP COLUMN witness_error,
  DROP COLUMN witness_state;
ALTER TABLE platform_business_observation
  DROP COLUMN relation_facts,
  DROP COLUMN process_exact_owner_id,
  DROP COLUMN process_exact_state,
  DROP COLUMN process_sql_fact_title_state,
  DROP COLUMN apply_exact_owner_id,
  DROP COLUMN apply_exact_state,
  DROP COLUMN apply_sql_fact_title_state,
  DROP COLUMN candidate_scope_rule,
  DROP COLUMN candidate_scope_archive_id,
  DROP COLUMN candidate_scope_rdjb,
  DROP COLUMN candidate_scope_title_code,
  DROP COLUMN candidate_scope_sequence_no,
  DROP COLUMN candidate_scope_error,
  DROP COLUMN candidate_scope_state,
  DROP COLUMN witness_rule,
  DROP COLUMN witness_collection_id,
  DROP COLUMN witness_sequence_no,
  DROP COLUMN witness_archive_id,
  DROP COLUMN witness_sha256,
  DROP COLUMN witness_ordinal,
  DROP COLUMN witness_rdjb_kind,
  DROP COLUMN witness_rdjb_value,
  DROP COLUMN witness_rdjb_value_sqlite_storage,
  DROP COLUMN witness_rdjb_key,
  DROP COLUMN witness_page_kind,
  DROP COLUMN witness_page_value,
  DROP COLUMN witness_page_value_sqlite_storage,
  DROP COLUMN witness_error_name,
  DROP COLUMN witness_error,
  DROP COLUMN witness_state;
ALTER TABLE platform_business_observation ADD CHECK (candidate_scope_mask BETWEEN 0 AND 7);

ALTER TABLE platform_apply_projection DISABLE TRIGGER platform_apply_projection_append_only;
DELETE FROM platform_apply_projection WHERE version_id IS NULL;
ALTER TABLE platform_apply_projection ENABLE TRIGGER platform_apply_projection_append_only;
ALTER TABLE platform_apply_projection
  DROP COLUMN exact_status,
  DROP COLUMN exact_status_sqlite_storage,
  DROP COLUMN exact_declare_kind,
  DROP COLUMN exact_declare_kind_sqlite_storage,
  DROP COLUMN exact_applied_at,
  DROP COLUMN exact_applied_at_sqlite_storage,
  DROP COLUMN exact_year,
  DROP COLUMN exact_year_sqlite_storage,
  DROP COLUMN exact_title_raw,
  DROP COLUMN exact_title_raw_sqlite_storage,
  DROP COLUMN exact_stored_state,
  DROP COLUMN exact_stored_rule,
  DROP COLUMN exact_stored_origin,
  DROP COLUMN exact_stored_reason,
  DROP COLUMN sql_fact_title,
  DROP COLUMN sql_fact_title_state,
  DROP COLUMN sql_fact_title_rule,
  DROP COLUMN sql_fact_title_reason,
  DROP COLUMN observation_id,
  DROP COLUMN basis,
  DROP COLUMN source_title_kind,
  DROP COLUMN source_title_text,
  DROP COLUMN source_title_number_text,
  DROP COLUMN source_title_boolean,
  DROP COLUMN source_title_rule_version,
  DROP COLUMN parse_state,
  DROP COLUMN stored_province,
  DROP COLUMN parsed_province,
  DROP COLUMN reconciled_province,
  DROP COLUMN province_conflict,
  DROP COLUMN stored_status,
  DROP COLUMN parsed_status,
  DROP COLUMN reconciled_status,
  DROP COLUMN status_conflict,
  DROP COLUMN stored_batch,
  DROP COLUMN parsed_batch,
  DROP COLUMN reconciled_batch,
  DROP COLUMN batch_conflict,
  DROP COLUMN stored_declare_kind,
  DROP COLUMN parsed_declare_kind,
  DROP COLUMN reconciled_declare_kind,
  DROP COLUMN declare_kind_conflict,
  DROP COLUMN stored_applied_at,
  DROP COLUMN parsed_applied_at,
  DROP COLUMN reconciled_applied_at,
  DROP COLUMN applied_at_conflict,
  DROP COLUMN stored_award_batch_label,
  DROP COLUMN parsed_award_batch_label,
  DROP COLUMN reconciled_award_batch_label,
  DROP COLUMN award_batch_label_conflict,
  DROP COLUMN stored_year,
  DROP COLUMN parsed_year,
  DROP COLUMN reconciled_year,
  DROP COLUMN year_conflict;
ALTER TABLE platform_apply_projection ALTER COLUMN version_id SET NOT NULL, ALTER COLUMN record_id SET NOT NULL;

ALTER TABLE platform_business_projection DISABLE TRIGGER platform_process_projection_append_only;
DELETE FROM platform_business_projection WHERE version_id IS NULL;
ALTER TABLE platform_business_projection ENABLE TRIGGER platform_process_projection_append_only;
ALTER TABLE platform_business_projection
  DROP COLUMN exact_status,
  DROP COLUMN exact_status_sqlite_storage,
  DROP COLUMN exact_declare_kind,
  DROP COLUMN exact_declare_kind_sqlite_storage,
  DROP COLUMN exact_applied_at,
  DROP COLUMN exact_applied_at_sqlite_storage,
  DROP COLUMN exact_year,
  DROP COLUMN exact_year_sqlite_storage,
  DROP COLUMN exact_title_raw,
  DROP COLUMN exact_title_raw_sqlite_storage,
  DROP COLUMN exact_batch,
  DROP COLUMN exact_batch_sqlite_storage,
  DROP COLUMN exact_award_batch_label,
  DROP COLUMN exact_award_batch_label_sqlite_storage,
  DROP COLUMN exact_province,
  DROP COLUMN exact_province_sqlite_storage,
  DROP COLUMN exact_stored_state,
  DROP COLUMN exact_stored_rule,
  DROP COLUMN exact_stored_origin,
  DROP COLUMN exact_stored_reason,
  DROP COLUMN sql_fact_title,
  DROP COLUMN sql_fact_title_state,
  DROP COLUMN sql_fact_title_rule,
  DROP COLUMN sql_fact_title_reason,
  DROP COLUMN observation_id,
  DROP COLUMN basis,
  DROP COLUMN source_title_kind,
  DROP COLUMN source_title_text,
  DROP COLUMN source_title_number_text,
  DROP COLUMN source_title_boolean,
  DROP COLUMN source_title_rule_version,
  DROP COLUMN parse_state,
  DROP COLUMN stored_province,
  DROP COLUMN parsed_province,
  DROP COLUMN reconciled_province,
  DROP COLUMN province_conflict,
  DROP COLUMN stored_status,
  DROP COLUMN stored_status_sqlite_storage,
  DROP COLUMN parsed_status,
  DROP COLUMN reconciled_status,
  DROP COLUMN reconciled_status_sqlite_storage,
  DROP COLUMN status_conflict,
  DROP COLUMN stored_batch,
  DROP COLUMN parsed_batch,
  DROP COLUMN reconciled_batch,
  DROP COLUMN batch_conflict,
  DROP COLUMN stored_declare_kind,
  DROP COLUMN parsed_declare_kind,
  DROP COLUMN reconciled_declare_kind,
  DROP COLUMN declare_kind_conflict,
  DROP COLUMN stored_applied_at,
  DROP COLUMN parsed_applied_at,
  DROP COLUMN reconciled_applied_at,
  DROP COLUMN applied_at_conflict,
  DROP COLUMN stored_award_batch_label,
  DROP COLUMN parsed_award_batch_label,
  DROP COLUMN reconciled_award_batch_label,
  DROP COLUMN award_batch_label_conflict,
  DROP COLUMN stored_year,
  DROP COLUMN parsed_year,
  DROP COLUMN reconciled_year,
  DROP COLUMN year_conflict;
ALTER TABLE platform_business_projection ALTER COLUMN version_id SET NOT NULL, ALTER COLUMN record_id SET NOT NULL;

DELETE FROM platform_recognized_projection WHERE version_id IS NULL;
ALTER TABLE platform_recognized_projection DROP CONSTRAINT IF EXISTS platform_recognized_projection_check;
ALTER TABLE platform_recognized_projection ALTER COLUMN source_valid_flag TYPE jsonb
  USING NULLIF(pg_temp.compact_source_cell(source_valid_flag, source_valid_flag_sqlite_storage), 'null'::jsonb);
ALTER TABLE platform_recognized_projection
  DROP COLUMN source_valid_flag_sqlite_storage,
  DROP COLUMN observation_id,
  DROP COLUMN basis,
  DROP COLUMN source_title_kind,
  DROP COLUMN source_title_text,
  DROP COLUMN source_title_number_text,
  DROP COLUMN source_title_boolean,
  DROP COLUMN source_title_rule_version,
  DROP COLUMN parse_state,
  DROP COLUMN stored_province,
  DROP COLUMN parsed_province,
  DROP COLUMN reconciled_province,
  DROP COLUMN province_conflict,
  DROP COLUMN stored_status,
  DROP COLUMN parsed_status,
  DROP COLUMN reconciled_status,
  DROP COLUMN status_conflict,
  DROP COLUMN stored_batch,
  DROP COLUMN parsed_batch,
  DROP COLUMN reconciled_batch,
  DROP COLUMN batch_conflict,
  DROP COLUMN stored_declare_kind,
  DROP COLUMN parsed_declare_kind,
  DROP COLUMN reconciled_declare_kind,
  DROP COLUMN declare_kind_conflict,
  DROP COLUMN stored_applied_at,
  DROP COLUMN parsed_applied_at,
  DROP COLUMN reconciled_applied_at,
  DROP COLUMN applied_at_conflict,
  DROP COLUMN stored_award_batch_label,
  DROP COLUMN parsed_award_batch_label,
  DROP COLUMN reconciled_award_batch_label,
  DROP COLUMN award_batch_label_conflict,
  DROP COLUMN stored_year,
  DROP COLUMN parsed_year,
  DROP COLUMN reconciled_year,
  DROP COLUMN year_conflict,
  DROP COLUMN exact_title_raw,
  DROP COLUMN exact_title_raw_sqlite_storage,
  DROP COLUMN exact_title_state;
ALTER TABLE platform_recognized_projection ALTER COLUMN version_id SET NOT NULL, ALTER COLUMN record_id SET NOT NULL;

\endif
COMMIT;
