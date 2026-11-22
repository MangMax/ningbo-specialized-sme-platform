\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

\ir support/platform-business-facts-columns.sql
\ir support/platform-observation-snapshot.sql
\ir support/platform-business-facts-backfill.sql
COMMIT;
