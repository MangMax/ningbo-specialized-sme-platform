\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path TO business, public;
SELECT (versions IS NOT NULL OR rows IS NOT NULL OR exports IS NOT NULL) AS staged_lead_lists,
       exports IS NOT NULL AS staged_lead_exports
FROM (SELECT to_regclass(format('%I.lead_list_version', :'staging')) AS versions,
             to_regclass(format('%I.lead_list_row', :'staging')) AS rows,
             to_regclass(format('%I.lead_list_export', :'staging')) AS exports) tables
\gset

\ir ../../db/postgresql/file-and-lead-list-schema.sql

INSERT INTO stored_file_audit (id, stored_file_id, old_display_name, new_display_name, created_at)
SELECT id, stored_file_id, old_display_name, new_display_name, created_at FROM :"staging".stored_file_audit;
INSERT INTO file_maintenance_audit
  (id, file_id, revision, action, idempotency_key, request_hash, mode, actor, basis, before_json, after_json, created_at)
SELECT id, file_id, revision, action, idempotency_key, request_hash, mode, actor, basis, before_json, after_json, created_at
FROM :"staging".file_maintenance_audit;
INSERT INTO file_physical_intent
  (id, file_id, rel_path, sha256, bytes, state, delete_key, delete_hash, delete_receipt, recover_key, recover_hash, recover_receipt, created_at)
SELECT id, file_id, rel_path, sha256, bytes, state, delete_key, delete_hash, delete_receipt, recover_key, recover_hash, recover_receipt, created_at
FROM :"staging".file_physical_intent;

\ir ../../db/postgresql/file-audit-triggers.sql

INSERT INTO enterprise_source_channel (code, name) VALUES ('research', '调研走访') ON CONFLICT DO NOTHING;
INSERT INTO enterprise_source_list_type (code, name) VALUES ('lead', '线索名单') ON CONFLICT DO NOTHING;

-- A snapshot from before lead-list installation has neither registration table.
-- If either exists, read both so a partial schema aborts materialization.
\if :staged_lead_lists
INSERT INTO lead_list_version
  (id, series, channel_code, list_type_code, acquired_on, file_id, file_sha256, request_hash, created_at)
SELECT id, series, channel_code, list_type_code, acquired_on, file_id, file_sha256, request_hash, created_at
FROM :"staging".lead_list_version;
INSERT INTO lead_list_row
  (id, version_id, row_number, name, uscc, district, note, enterprise_id, review_hash, review_actor, review_basis, reviewed_at)
SELECT id, version_id, row_number, name, uscc, district, note, enterprise_id, review_hash, review_actor, review_basis, reviewed_at
FROM :"staging".lead_list_row;
\endif

INSERT INTO ocr_result (id,file_id,page_no,revision,page_rel_path,markdown,raw,engine,model,channel,created_at)
SELECT id,file_id,page_no,revision,page_rel_path,markdown,raw,engine,model,channel,created_at FROM :"staging".ocr_result;

SELECT format('SELECT setval(%L, %s, %L)',
              pg_get_serial_sequence(format('business.%I', name), 'id'),
              greatest(seq, 1), coalesce(seq >= 1, false))
FROM (
  SELECT name, max(high_water) AS seq
  FROM (
    -- The staging tool can tag SQLite sequence integers as big-endian bytea.
    SELECT name, CASE WHEN to_jsonb(s)->>'seq_sqlite_storage' = 'integer'
        THEN ('x' || substr(seq::text, 3))::bit(64)::bigint
        ELSE seq::text::bigint END AS high_water
    FROM :"staging".sqlite_sequence s
    WHERE name IN ('stored_file_audit', 'file_maintenance_audit', 'ocr_result')
    UNION ALL SELECT 'stored_file_audit', max(id) FROM stored_file_audit
    UNION ALL SELECT 'file_maintenance_audit', max(id) FROM file_maintenance_audit
    UNION ALL SELECT 'ocr_result', max(id) FROM ocr_result
    UNION ALL SELECT 'lead_list_version', max(id) FROM lead_list_version
    UNION ALL SELECT 'lead_list_row', max(id) FROM lead_list_row
  ) highs GROUP BY name
) sequences
\gexec

\if :staged_lead_exports
INSERT INTO lead_list_export (job_id, version_id, content)
SELECT job_id, version_id, content FROM :"staging".lead_list_export;
\endif

ANALYZE stored_file_audit, file_maintenance_audit, file_physical_intent, ocr_result, lead_list_version, lead_list_row, lead_list_export;
COMMIT;
