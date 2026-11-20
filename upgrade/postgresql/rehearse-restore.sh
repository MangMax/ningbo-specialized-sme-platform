#!/usr/bin/env bash
# Run on an isolated PostgreSQL 19 cluster populated from a frozen copy.
set -euo pipefail
umask 077

if [[ ${PGHOST:-} != /* || ! -d ${PGHOST:-} || -n ${PGHOSTADDR:-} || -n ${PGSERVICE:-} ||
      ! ${PGDATABASE:-} =~ ^[a-zA-Z_][a-zA-Z_0-9-]*$ ]]; then
  echo 'Set PGHOST to an isolated Unix socket directory and PGDATABASE to its frozen source database name.' >&2
  exit 2
fi

if [[ -n ${PGSQL_BIN:-} ]]; then
  export PATH="$PGSQL_BIN:$PATH"
fi
for tool in psql pg_dump pg_restore createdb dropdb; do
  if [[ $("$tool" --version) != *' (PostgreSQL) 19.'* ]]; then
    echo "PostgreSQL 19 $tool is required." >&2
    exit 2
  fi
done

query() { psql -X -w -A -t -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }
version=$(query "$PGDATABASE" "SHOW server_version_num")
if (( version < 190000 || version >= 200000 )); then
  echo 'PostgreSQL 19 server is required.' >&2
  exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/ningbo-restore.XXXXXXXX")
target="restore_${scratch##*.}"
created=false
cleanup() {
  local status=$?
  if "$created"; then
    dropdb -w --maintenance-db="$PGDATABASE" "$target" || status=1
  fi
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

manifest() {
  local database=$1 label=$2 kind relation ordered_columns hash
  query "$database" "
    SELECT c.relkind::text || chr(9) || format('%I.%I', n.nspname,c.relname) || chr(9) ||
      coalesce((SELECT string_agg(format('%I', a.attname), ', ' ORDER BY k.ordinality)
        FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid AND
          i.indpred IS NULL AND i.indexprs IS NULL AND k.ordinality <= i.indnkeyatts
        GROUP BY i.indexrelid, i.indisprimary, i.indnullsnotdistinct
        HAVING i.indnullsnotdistinct OR bool_and(a.attnotnull)
        ORDER BY i.indisprimary DESC, i.indexrelid::regclass::text COLLATE \"C\"
        LIMIT 1), '-')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('business', 'runtime_logs') AND c.relkind IN ('r', 'S')
    ORDER BY n.nspname COLLATE \"C\", c.relname COLLATE \"C\"
  " > "$scratch/$label.relations"

  for schema in business runtime_logs; do
    if ! grep -q $'^r\t'"$schema\." "$scratch/$label.relations"; then
      echo "Missing tables in $schema." >&2
      return 1
    fi
  done

  while IFS=$'\t' read -r kind relation ordered_columns; do
    case "$kind" in
      r)
        if [[ $ordered_columns == '-' ]]; then
          echo "No complete unique ordering key for $relation." >&2
          return 1
        fi
        hash=$(query "$database" "COPY (SELECT * FROM $relation ORDER BY $ordered_columns) TO STDOUT (FORMAT binary)" |
          openssl dgst -sha256 -r)
        printf '%s\t%s\t%s\n' "$relation" "$ordered_columns" "${hash%% *}"
        ;;
      S)
        printf '%s\t%s\n' "$relation" "$(query "$database" "SELECT last_value, is_called FROM $relation")"
        ;;
    esac
  done < "$scratch/$label.relations"
}

manifest "$PGDATABASE" source > "$scratch/source.manifest"
pg_dump -w --format=custom --schema=business --schema=runtime_logs --file="$scratch/database.dump" --dbname="$PGDATABASE"
createdb -w --maintenance-db="$PGDATABASE" --template=template0 "$target"
created=true
query "$target" 'CREATE EXTENSION pg_trgm' >/dev/null
pg_restore -w --single-transaction --exit-on-error --no-owner --no-privileges --dbname="$target" "$scratch/database.dump"
manifest "$target" restored > "$scratch/restored.manifest"
diff -u "$scratch/source.manifest" "$scratch/restored.manifest"
printf 'PostgreSQL 19 backup restored. Matched table hashes and sequence states for %s relations.\n' "$(wc -l < "$scratch/source.manifest" | tr -d ' ')"
