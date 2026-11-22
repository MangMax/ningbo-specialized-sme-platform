#!/usr/bin/env bash
set -euo pipefail

# Historical chain: run from 59ae7ff4 with steps 18 and 19 from the same checkout.
# Step 18 installs the three-argument retention SQL. Step 19 imports the matching
# application helper and prunes while the record_correspondence references still exist.

: "${PGDATABASE:?set the database to compact}"
cd "$(dirname "$0")"
client=${PGSQL_BIN:-psql}
if [[ -d "$client" ]]; then client="$client/psql"; fi
"$client" -X -w -f apply.sql
node steps/17-refresh-platform-digests.mjs
"$client" -X -w -f steps/18-install-platform-capture-retention.sql
node steps/19-prune-platform-captures.mjs
