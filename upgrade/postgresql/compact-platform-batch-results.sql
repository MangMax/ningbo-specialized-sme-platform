\set ON_ERROR_STOP on
BEGIN;

\ir ../../db/postgresql/platform-batch-segments.sql
\ir split-platform-batch-results.sql

COMMIT;
