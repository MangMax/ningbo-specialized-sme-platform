\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

SELECT EXISTS (
  SELECT FROM pg_attribute
  WHERE attrelid = 'platform_apply_projection'::regclass AND attname = 'source_archive_id' AND NOT attisdropped
) AS has_legacy_projection_columns
\gset
\if :has_legacy_projection_columns
DROP TRIGGER platform_recognized_exact_title_fixed ON platform_recognized_projection;

ALTER TABLE platform_apply_projection
  DROP COLUMN parsed_applied_at_kind,
  DROP COLUMN parsed_award_batch_label_kind,
  DROP COLUMN parsed_batch_kind,
  DROP COLUMN parsed_declare_kind_kind,
  DROP COLUMN parsed_province_kind,
  DROP COLUMN parsed_status_kind,
  DROP COLUMN parsed_year_kind,
  DROP COLUMN source_archive_id,
  DROP COLUMN stored_applied_at_kind,
  DROP COLUMN stored_award_batch_label_kind,
  DROP COLUMN stored_batch_kind,
  DROP COLUMN stored_declare_kind_kind,
  DROP COLUMN stored_province_kind,
  DROP COLUMN stored_status_kind,
  DROP COLUMN stored_year_kind;

ALTER TABLE platform_business_projection
  DROP COLUMN parsed_applied_at_kind,
  DROP COLUMN parsed_award_batch_label_kind,
  DROP COLUMN parsed_batch_kind,
  DROP COLUMN parsed_declare_kind_kind,
  DROP COLUMN parsed_province_kind,
  DROP COLUMN parsed_status_kind,
  DROP COLUMN parsed_year_kind,
  DROP COLUMN source_archive_id,
  DROP COLUMN stored_applied_at_kind,
  DROP COLUMN stored_award_batch_label_kind,
  DROP COLUMN stored_batch_kind,
  DROP COLUMN stored_declare_kind_kind,
  DROP COLUMN stored_province_kind,
  DROP COLUMN stored_status_kind,
  DROP COLUMN stored_year_kind;

ALTER TABLE platform_recognized_projection
  DROP COLUMN exact_title_archive_id,
  DROP COLUMN exact_title_origin,
  DROP COLUMN exact_title_sha256,
  DROP COLUMN parsed_applied_at_kind,
  DROP COLUMN parsed_award_batch_label_kind,
  DROP COLUMN parsed_batch_kind,
  DROP COLUMN parsed_declare_kind_kind,
  DROP COLUMN parsed_province_kind,
  DROP COLUMN parsed_status_kind,
  DROP COLUMN parsed_year_kind,
  DROP COLUMN source_archive_id,
  DROP COLUMN stored_applied_at_kind,
  DROP COLUMN stored_award_batch_label_kind,
  DROP COLUMN stored_batch_kind,
  DROP COLUMN stored_declare_kind_kind,
  DROP COLUMN stored_province_kind,
  DROP COLUMN stored_status_kind,
  DROP COLUMN stored_year_kind;

\ir ../../../../db/postgresql/platform-projection-comparison-constraints.sql
\ir ../../../../db/postgresql/platform-recognized-title-trigger.sql
\endif
COMMIT;
