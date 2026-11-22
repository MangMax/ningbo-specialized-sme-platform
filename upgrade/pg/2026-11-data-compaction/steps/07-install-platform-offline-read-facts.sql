\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;
ALTER TABLE platform_collection ADD COLUMN IF NOT EXISTS source_coverage jsonb,
  ADD COLUMN IF NOT EXISTS raw_response_sha256 text,
  ADD COLUMN IF NOT EXISTS reusable_content_sha256 text;
ALTER TABLE platform_business_observation ADD COLUMN IF NOT EXISTS relation_facts jsonb,
  ADD COLUMN IF NOT EXISTS business_fields jsonb;
ALTER TABLE platform_business_record_version ADD COLUMN IF NOT EXISTS business_fields jsonb;
\ir support/platform-offline-read-facts.sql
COMMIT;
