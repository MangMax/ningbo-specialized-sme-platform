#!/usr/bin/env bash
set -euo pipefail

: "${PGDATABASE:?set the database to compact}"
cd "$(dirname "$0")/../.."
client=${PGSQL_BIN:-psql}
if [[ -d "$client" ]]; then client="$client/psql"; fi
"$client" -X -w -f upgrade/postgresql/apply-data-compaction.sql
node upgrade/postgresql/install-platform-refresh-v2.mjs
