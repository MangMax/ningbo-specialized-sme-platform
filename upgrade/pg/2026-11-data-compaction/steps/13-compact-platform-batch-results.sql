\set ON_ERROR_STOP on
BEGIN;

\ir ../../../../db/postgresql/platform-batch-segments.sql
\ir support/split-platform-batch-results.sql
\ir support/project-platform-batch-business-rows.sql

COMMIT;
