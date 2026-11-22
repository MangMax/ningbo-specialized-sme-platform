#!/usr/bin/env bash
set -euo pipefail

: "${PGDATABASE:?set the database to compact}"
cd "$(dirname "$0")"
client=${PGSQL_BIN:-psql}
if [[ -d "$client" ]]; then client="$client/psql"; fi
"$client" -X -w -f apply.sql
node steps/17-refresh-platform-digests.mjs
