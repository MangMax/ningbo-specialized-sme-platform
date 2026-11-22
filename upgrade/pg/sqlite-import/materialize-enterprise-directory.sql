\set ON_ERROR_STOP on
BEGIN;
CREATE SCHEMA business;
SET LOCAL search_path TO business, public;

\ir ../../../db/postgresql/enterprise-directory-schema.sql

INSERT INTO service_credential (key,value,updated_at)
SELECT key,value,updated_at FROM :"staging".service_credential;

INSERT INTO enterprise SELECT id, uscc_norm, name, name_norm, district, city, reg_status, quality_flags FROM :"staging".enterprise;
INSERT INTO enterprise_merge SELECT from_enterprise_id, into_enterprise_id, basis, recorded_at FROM :"staging".enterprise_merge;
INSERT INTO enterprise_region SELECT code, name, parent_code, level FROM :"staging".enterprise_region;
INSERT INTO enterprise_industry SELECT code, input_id, name, parent_code, level, description FROM :"staging".enterprise_industry;
INSERT INTO enterprise_directory SELECT enterprise_id, district_code, township_code, industry_code, removed_reason, revision FROM :"staging".enterprise_directory;
INSERT INTO enterprise_address SELECT enterprise_id, kind, address FROM :"staging".enterprise_address;
INSERT INTO stored_file SELECT id, rel_path, display_name, filename, ext, bytes, sha256, created_at, removed_at FROM :"staging".stored_file;
INSERT INTO enterprise_source_channel SELECT code, name FROM :"staging".enterprise_source_channel;
INSERT INTO enterprise_source_list_type SELECT code, name FROM :"staging".enterprise_source_list_type;
INSERT INTO enterprise_source SELECT id, module, business_table, version_key, channel_code, list_type_code, acquired_on, series, file_id, sha256 FROM :"staging".enterprise_source;
INSERT INTO enterprise_source_link SELECT enterprise_id, source_id FROM :"staging".enterprise_source_link;

SELECT format('SELECT setval(%L, %s, %L)',
              pg_get_serial_sequence(format('business.%I', name), 'id'),
              greatest(seq, 1), coalesce(seq >= 1, false))
FROM (
  SELECT name, max(high_water) AS seq
  FROM (
    -- Staging uses tagged bytea when any SQLite sequence cell has mixed storage.
    SELECT name, CASE WHEN to_jsonb(s)->>'seq_sqlite_storage' = 'integer'
        THEN ('x' || substr(seq::text, 3))::bit(64)::bigint
        ELSE seq::text::bigint END AS high_water
    FROM :"staging".sqlite_sequence s
    WHERE name IN ('enterprise', 'enterprise_source', 'stored_file')
    UNION ALL SELECT 'enterprise', max(id) FROM enterprise
    UNION ALL SELECT 'enterprise_source', max(id) FROM enterprise_source
    UNION ALL SELECT 'stored_file', max(id) FROM stored_file
  ) highs GROUP BY name
) sequences
\gexec

\ir ../../../db/postgresql/enterprise-directory-indexes.sql

ANALYZE enterprise, enterprise_merge, enterprise_region, enterprise_industry, enterprise_directory,
  enterprise_address, stored_file, enterprise_source, enterprise_source_link;
COMMIT;
