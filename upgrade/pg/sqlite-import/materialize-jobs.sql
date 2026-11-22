\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, public;

\ir ../../../db/postgresql/job-schema.sql

INSERT INTO business.job (id, kind, params, state, progress, result, error, created_at, started_at, finished_at)
SELECT id, kind, params, state, progress, result, error, created_at, started_at, finished_at
FROM :"staging".job;

\ir ../../../db/postgresql/job-integrity.sql
\ir ../../../db/postgresql/platform-batch-segments.sql
\ir ../2026-11-data-compaction/steps/support/split-platform-batch-results.sql
\ir ../2026-11-data-compaction/steps/support/project-platform-batch-business-rows.sql

ANALYZE business.job;
COMMIT;
