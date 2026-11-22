\set ON_ERROR_STOP on
\ir install-runtime-log-compaction.sql
\ir remove-offline-platform-tables.sql
\ir install-platform-canonical-archive.sql
\ir compact-platform-collection-conditions.sql
\ir install-platform-observation-snapshot-compaction.sql
\ir install-platform-legacy-fingerprint-pruning.sql
\ir remove-automatic-correspondence-candidates.sql
\ir install-correspondence-query-evidence-compaction.sql
\ir compact-import-receipts.sql
\ir compact-platform-batch-results.sql
\ir retire-evidence-impact-tracker.sql
\ir retire-comparison-scope-proof.sql
