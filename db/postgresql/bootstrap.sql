\set ON_ERROR_STOP on

BEGIN;
DO $$
BEGIN
  IF current_setting('server_version_num')::integer NOT BETWEEN 190000 AND 199999
    OR current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Runtime bootstrap requires UTF-8 PostgreSQL 19';
  END IF;
END
$$;

\if :logs_only
\else
CREATE SCHEMA business;
SET LOCAL search_path TO business, public;
\ir enterprise-directory-schema.sql
\ir enterprise-directory-indexes.sql
\ir enterprise-identity-schema.sql
\ir enterprise-identity-integrity.sql
\ir job-schema.sql
\ir job-integrity.sql
\ir platform-batch-segments.sql
\ir file-and-lead-list-schema.sql
\ir file-audit-triggers.sql

SET LOCAL search_path TO business, pg_catalog;
\ir roster-schema.sql
\ir roster-platform-schema.sql
\ir roster-review-schema.sql
\ir roster-constraints.sql
\ir roster-triggers.sql

INSERT INTO enterprise_kernel_completion (id, version) VALUES (1, :'kernel_version');
INSERT INTO enterprise_source_channel (code, name) VALUES
  ('direct', '直接添加'), ('jxj', '经信局'), ('miit', '工信部'), ('research', '调研走访');
INSERT INTO enterprise_source_list_type (code, name) VALUES
  ('direct', '直接添加'), ('announcement', '公布名单'), ('lead', '线索名单');
INSERT INTO title (code, name_zh, level, rank)
SELECT row.code, row."nameZh", row.level, row.rank
FROM jsonb_to_recordset(:'titles'::jsonb) AS row(code text, "nameZh" text, level text, rank bigint);
\endif

CREATE SCHEMA runtime_logs;
SET LOCAL search_path TO runtime_logs, pg_catalog;
\ir runtime-log-schema.sql
\ir runtime-log-indexes.sql
INSERT INTO log_policy (id, "retentionDays", "maxBytes") VALUES (1, :'retention_days', :'max_bytes');
INSERT INTO log_collection (id, collection, revision) VALUES (1, :'log_collection', 0);
COMMIT;
