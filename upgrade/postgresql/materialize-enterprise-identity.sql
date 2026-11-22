\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, public;

\ir ../../db/postgresql/enterprise-identity-schema.sql

INSERT INTO enterprise_kernel_completion (id, version, region_sha256, industry_sha256)
SELECT id, version, region_sha256, industry_sha256 FROM :"staging".enterprise_kernel_completion;
INSERT INTO enterprise_alias (
  id, enterprise_id, name, name_norm, source_kind, source_ref_id, valid_from, valid_to, verification_status,
  note, created_at, version, original_name, original_source_kind, original_source_ref_id
)
SELECT id, enterprise_id, name, name_norm, source_kind, source_ref_id, valid_from, valid_to, verification_status,
  note, created_at, version, original_name, original_source_kind, original_source_ref_id FROM :"staging".enterprise_alias;
INSERT INTO enterprise_former_name (alias_id, uscc, renamed_year)
SELECT alias_id, uscc, renamed_year FROM :"staging".enterprise_former_name;
INSERT INTO enterprise_alias_audit (id, alias_id, enterprise_id, action, actor, basis, idempotency_key, request_hash, before, after, created_at)
SELECT id, alias_id, enterprise_id, action, actor, basis, idempotency_key, request_hash, before, after, created_at
FROM :"staging".enterprise_alias_audit;
INSERT INTO enterprise_profile_audit (
  id, enterprise_id, idempotency_key, request_hash, before_version, after_version,
  before, after, actor, basis, retained_alias_id, alias_created, created_at
)
SELECT id, enterprise_id, idempotency_key, request_hash, before_version, after_version,
  before, after, actor, basis, retained_alias_id, alias_created, created_at FROM :"staging".enterprise_profile_audit;

SET LOCAL bytea_output TO 'hex';
SELECT format('SELECT setval(%L, %s, %L)', pg_get_serial_sequence(format('business.%I', name), 'id'),
  greatest(seq, 1), coalesce(seq >= 1, false))
FROM (
  SELECT name, max(high_water) AS seq
  FROM (
    SELECT name, CASE WHEN to_jsonb(s)->>'seq_sqlite_storage' = 'integer'
        THEN ('x' || substr(seq::text, 3))::bit(64)::bigint
        ELSE seq::text::bigint END AS high_water
    FROM :"staging".sqlite_sequence s
    WHERE name IN ('enterprise_alias', 'enterprise_alias_audit', 'enterprise_profile_audit')
    UNION ALL SELECT 'enterprise_alias', max(id) FROM enterprise_alias
    UNION ALL SELECT 'enterprise_alias_audit', max(id) FROM enterprise_alias_audit
    UNION ALL SELECT 'enterprise_profile_audit', max(id) FROM enterprise_profile_audit
  ) highs GROUP BY name
) sequences
\gexec

\ir ../../db/postgresql/enterprise-identity-integrity.sql

ANALYZE enterprise_alias, enterprise_former_name, enterprise_alias_audit, enterprise_profile_audit;
COMMIT;
