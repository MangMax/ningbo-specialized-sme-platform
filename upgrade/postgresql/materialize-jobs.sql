\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, public;

\ir ../../db/postgresql/job-schema.sql

INSERT INTO business.job (id, kind, params, state, progress, result, error, created_at, started_at, finished_at)
SELECT id, kind, params, state, progress, result, error, created_at, started_at, finished_at
FROM :"staging".job;

\ir ../../db/postgresql/job-integrity.sql
\ir ../../db/postgresql/platform-batch-segments.sql
\ir split-platform-batch-results.sql
\ir project-platform-batch-business-rows.sql

ANALYZE business.job;
COMMIT;
