#!/usr/bin/env bash
set -euo pipefail

: "${PGDATABASE:?set the database to annotate}"
cd "$(dirname "$0")"
client=${PGSQL_BIN:-psql}
if [[ -d "$client" ]]; then client="$client/psql"; fi
"$client" -X -w -f apply.sql
