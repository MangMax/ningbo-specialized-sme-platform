\set ON_ERROR_STOP on
BEGIN;

\ir ../../db/postgresql/platform-batch-segments.sql
\ir split-platform-batch-results.sql
\ir project-platform-batch-business-rows.sql

COMMIT;
