\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;

\ir ../../../../db/postgresql/platform-business-facts-columns.sql
\ir ../../../../db/postgresql/platform-observation-snapshot.sql
\ir ../../../../db/postgresql/platform-business-facts-backfill.sql
COMMIT;
