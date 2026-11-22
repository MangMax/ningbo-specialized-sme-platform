\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

LOCK TABLE platform_archive_value, platform_observation_fingerprint_basis IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE legacy_platform_fingerprint_release ON COMMIT DROP AS
SELECT observation_id, input_archive_id AS archive_id
FROM platform_observation_fingerprint_basis
WHERE scheme IN ('legacy-indexed-v1', 'legacy-bootstrap-v1') AND input_archive_id IS NOT NULL;

\ir ../../db/postgresql/platform-fingerprint-legacy-verify.sql

ALTER TABLE platform_observation_fingerprint_basis DROP CONSTRAINT platform_fingerprint_basis_input;
ALTER TABLE platform_observation_fingerprint_basis DISABLE TRIGGER platform_fingerprint_append_only;

UPDATE platform_observation_fingerprint_basis b
SET input_archive_id = NULL
FROM pg_temp.legacy_platform_fingerprint_release r
WHERE b.observation_id = r.observation_id;

ALTER TABLE platform_observation_fingerprint_basis ENABLE TRIGGER platform_fingerprint_append_only;
ALTER TABLE platform_observation_fingerprint_basis
  ADD CONSTRAINT platform_fingerprint_basis_input CHECK ((scheme = 'target-command-v1') = (input_archive_id IS NOT NULL));

\ir ../../db/postgresql/platform-fingerprint-legacy-prune.sql

COMMIT;
