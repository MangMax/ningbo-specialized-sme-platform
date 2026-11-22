\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;
DROP TABLE IF EXISTS platform_migration_checkpoint, platform_migration_run, reconciliation_result;
COMMIT;
