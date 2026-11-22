\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

LOCK TABLE platform_business_record_version IN ACCESS EXCLUSIVE MODE;

SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'platform_business_record_version'::regclass AND attname = 'canonical_raw_json' AND NOT attisdropped
) AS has_canonical_text
\gset

\if :has_canonical_text
DO $migration$
DECLARE invalid_version bigint;
BEGIN
  SELECT min(v.id) INTO invalid_version
  FROM platform_business_record_version v
  LEFT JOIN platform_version_archive_ref r
    ON r.owner_id = v.id AND r.archive_id = v.canonical_archive_id AND r.field = 'canonicalRawJson' AND r.sealed = 1
  LEFT JOIN platform_archive_value a ON a.id = r.archive_id AND a.storage_class = 'text'
  WHERE a.id IS NULL OR a.bytes IS DISTINCT FROM convert_to(v.canonical_raw_json, 'UTF8');

  IF invalid_version IS NOT NULL THEN
    RAISE EXCEPTION 'Canonical platform version % has no matching sealed text archive', invalid_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$migration$;

\ir ../../db/postgresql/platform-canonical-archive-triggers.sql

ALTER TABLE platform_business_record_version
  ALTER COLUMN canonical_archive_id SET NOT NULL,
  DROP COLUMN canonical_raw_json;
\endif

COMMIT;
