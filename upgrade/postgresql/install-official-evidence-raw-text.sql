\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE business.official_evidence_row_revision
  ADD COLUMN IF NOT EXISTS name_raw_json text,
  ADD COLUMN IF NOT EXISTS uscc_raw_json text,
  ADD COLUMN IF NOT EXISTS district_raw_json text;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'business.official_evidence_row_revision'::regclass
      AND conname = 'official_evidence_raw_json_ck'
  ) THEN
    ALTER TABLE business.official_evidence_row_revision
      ADD CONSTRAINT official_evidence_raw_json_ck CHECK (
        (name_raw_json IS NULL OR (name_raw IS NULL AND json_typeof(name_raw_json::json) = 'string')) AND
        (uscc_raw_json IS NULL OR (uscc_raw IS NULL AND json_typeof(uscc_raw_json::json) = 'string')) AND
        (district_raw_json IS NULL OR (district_raw IS NULL AND json_typeof(district_raw_json::json) = 'string'))
      );
  END IF;
END
$install$;

COMMIT;
