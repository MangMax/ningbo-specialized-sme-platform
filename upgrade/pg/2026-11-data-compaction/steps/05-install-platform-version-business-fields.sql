\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

LOCK TABLE platform_business_record_version, platform_business_observation IN ACCESS EXCLUSIVE MODE;

SELECT NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='platform_business_observation'::regclass AND conname='platform_observation_business_fields_owner'
) AS moving_observation_fields
\gset

\if :moving_observation_fields
ALTER TABLE platform_business_record_version ADD COLUMN IF NOT EXISTS business_fields jsonb;
ALTER TABLE platform_business_observation ADD COLUMN IF NOT EXISTS business_fields jsonb;
CREATE TEMP TABLE projected_platform_business_fields ON COMMIT DROP AS
SELECT id AS observation_id, version_id, business_fields AS facts
FROM platform_business_observation;

\ir ../../../../db/postgresql/platform-version-business-fields-projection.sql

ALTER TABLE platform_business_observation ADD CONSTRAINT platform_observation_business_fields_owner
  CHECK (version_id IS NULL OR business_fields IS NULL);
\endif

COMMIT;
