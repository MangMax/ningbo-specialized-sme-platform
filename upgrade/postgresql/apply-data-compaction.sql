\set ON_ERROR_STOP on
\ir install-runtime-log-compaction.sql
\ir remove-offline-platform-tables.sql
\ir install-platform-public-ids.sql
\ir remove-automatic-correspondence-candidates.sql
SELECT to_regclass('business.platform_archive_value') IS NOT NULL AS platform_online_archives
\gset
\ir install-platform-version-business-fields.sql
\if :platform_online_archives
\ir install-platform-business-facts.sql
\ir install-platform-offline-read-facts.sql
\ir retire-platform-online-archives.sql
\endif
\ir install-platform-collection-scope.sql
\ir install-correspondence-query-evidence-compaction.sql
\ir compact-import-receipts.sql
\ir compact-platform-batch-results.sql
\ir retire-evidence-impact-tracker.sql
\ir retire-comparison-scope-proof.sql
