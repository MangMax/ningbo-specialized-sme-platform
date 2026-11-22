\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;
DROP TABLE IF EXISTS platform_migration_checkpoint, platform_migration_run, reconciliation_result, business.platform_query_title_scope_error;
COMMIT;
