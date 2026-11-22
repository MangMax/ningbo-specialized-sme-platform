\set ON_ERROR_STOP on
\ir steps/01-install-runtime-log-compaction.sql
\ir steps/02-remove-offline-platform-tables.sql
\ir steps/03-install-platform-public-ids.sql
\ir steps/04-remove-automatic-correspondence-candidates.sql
SELECT to_regclass('business.platform_archive_value') IS NOT NULL AS platform_online_archives
\gset
\ir steps/05-install-platform-version-business-fields.sql
\if :platform_online_archives
\ir steps/06-install-platform-business-facts.sql
\ir steps/07-install-platform-offline-read-facts.sql
\ir steps/08-retire-platform-online-archives.sql
\endif
\ir steps/09-install-platform-collection-scope.sql
\ir steps/10-install-platform-projection-compaction.sql
\ir steps/11-install-correspondence-query-evidence-compaction.sql
\ir steps/12-compact-import-receipts.sql
\ir steps/13-compact-platform-batch-results.sql
\ir steps/14-retire-evidence-impact-tracker.sql
\ir steps/15-retire-comparison-scope-proof.sql
