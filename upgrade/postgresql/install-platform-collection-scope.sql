\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

BEGIN;
SET LOCAL search_path TO :"target", pg_catalog;
ALTER TABLE platform_collection
  ADD COLUMN IF NOT EXISTS condition_facts jsonb,
  ADD COLUMN IF NOT EXISTS unfinished_positions jsonb NOT NULL DEFAULT '[]'::jsonb;

SELECT to_regclass(format('%I.platform_collection_condition', :'target')) IS NOT NULL AS migrate_collection_scope
\gset
\if :migrate_collection_scope
\set scope_source :target
\ir backfill-platform-collection-scope.sql
DROP TABLE platform_collection_condition, platform_collection_unfinished;
\endif
\ir ../../db/postgresql/platform-collection-scope-integrity.sql
COMMIT;
