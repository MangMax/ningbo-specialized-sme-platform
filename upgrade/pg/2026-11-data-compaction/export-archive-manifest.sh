#!/usr/bin/env bash
# Run on the frozen source and on a local restore of its original pg_dump.
set -euo pipefail

if [[ ${PGHOST:-} != /* || ! -d ${PGHOST:-} || -n ${PGHOSTADDR:-} || -n ${PGSERVICE:-} ||
      ! ${PGDATABASE:-} =~ ^[a-zA-Z_][a-zA-Z_0-9-]*$ ]]; then
  echo 'Set PGHOST to an isolated Unix socket directory and PGDATABASE to its frozen database name.' >&2
  exit 2
fi

if [[ -n ${PGSQL_BIN:-} ]]; then
  if [[ -f "$PGSQL_BIN" ]]; then
    export PATH="$(dirname "$PGSQL_BIN"):$PATH"
  else
    export PATH="$PGSQL_BIN:$PATH"
  fi
fi
if [[ $(psql --version) != *' (PostgreSQL) 19.'* ]]; then
  echo 'PostgreSQL 19 psql is required.' >&2
  exit 2
fi

export PGOPTIONS='-c default_transaction_read_only=on'
query() { psql -X -w -qAt -v ON_ERROR_STOP=1 -d "$PGDATABASE" -c "$1"; }
if [[ $(query 'SHOW server_version_num') != 19???? ]]; then
  echo 'PostgreSQL 19 server is required.' >&2
  exit 2
fi

# PostgreSQL binary COPY keeps bytea, empty text, NULL and JSON text distinct.
# The frozen source must stay unchanged while the individual tables are read.
while IFS='|' read -r relation order predicate; do
  digest=$(query "COPY (SELECT * FROM business.$relation $predicate ORDER BY $order) TO STDOUT (FORMAT binary)" |
    openssl dgst -sha256 -r)
  printf 'table\t%s\t%s\n' "$relation" "${digest%% *}"
done <<'TABLES'
platform_archive_value|id
platform_collection|id
platform_collection_archive_ref|owner_id, field COLLATE "C"
platform_collection_condition|collection_id, name COLLATE "C"
platform_collection_legacy_provenance|collection_id
platform_collection_page|id
platform_collection_unfinished|collection_id, ordinal
platform_legacy_query_alias|old_id
platform_query_title_scope|collection_id, rdjb COLLATE "C"
platform_query_title_scope_error|collection_id
platform_business_observation|id
platform_observation_archive_ref|owner_id, field COLLATE "C"
platform_observation_assignment|observation_id, revision
platform_observation_fingerprint_basis|observation_id
platform_legacy_relation_alias|old_id
platform_business_record|id
platform_business_record_version|id
platform_version_archive_ref|owner_id, field COLLATE "C"
platform_apply_projection|id
platform_business_projection|id
platform_recognized_projection|id
platform_migration_run|run_id COLLATE "C"
platform_migration_checkpoint|run_id COLLATE "C", phase COLLATE "C", source_table COLLATE "C"
reconciliation_result|id
import_batch|id|WHERE source_kind = 'platform_archive' OR id IN (SELECT batch_id FROM business.platform_business_observation UNION SELECT import_batch_id FROM business.platform_collection_legacy_provenance)
import_receipt|id|WHERE batch_id IN (SELECT id FROM business.import_batch WHERE source_kind = 'platform_archive' UNION SELECT batch_id FROM business.platform_business_observation UNION SELECT import_batch_id FROM business.platform_collection_legacy_provenance)
job|id COLLATE "C"|WHERE kind = 'platform-query-batch'
TABLES

# Count archived bodies and their bytes separately from SQL NULL bindings.
# Page positions survive independently of whether an original body was captured.
query "COPY (
  SELECT 'body', c.interface, r.field, a.storage_class, count(*), coalesce(sum(a.byte_length), 0)
  FROM business.platform_collection c
  JOIN business.platform_collection_archive_ref r ON r.owner_id = c.id
  JOIN business.platform_archive_value a ON a.id = r.archive_id
  GROUP BY c.interface, r.field, a.storage_class
  ORDER BY c.interface COLLATE \"C\", r.field COLLATE \"C\", a.storage_class COLLATE \"C\"
) TO STDOUT"
query "COPY (
  SELECT 'page', c.interface, p.position_state, count(*)
  FROM business.platform_collection c
  JOIN business.platform_collection_page p ON p.collection_id = c.id
  GROUP BY c.interface, p.position_state
  ORDER BY c.interface COLLATE \"C\", p.position_state COLLATE \"C\"
) TO STDOUT"
