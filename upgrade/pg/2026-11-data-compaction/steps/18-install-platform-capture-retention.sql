BEGIN;
SET LOCAL search_path TO business, pg_catalog;
\ir ../../../../db/postgresql/platform-capture-retention.sql
SELECT prune_platform_captures(NULL, true) AS retired_observations;
COMMIT;
