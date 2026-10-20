# #90 isolated synthetic PoC

Source only. Copy these files to `/tmp/ningbo-perf-83-90/postgres-poc` before running; keep generated DB, PGDATA, secrets, backups and results there. `poc.py` rejects an SQLite path outside that directory. It models a tiny batch/source/relation/audit chain over public local HTTP and MCP-like JSON-RPC calls. It is **not** the production application or a PostgreSQL migration.

Requirements: Docker with `postgres:18` available, `uv`, free loopback ports 55490–55492. Use a private directory (`chmod 700`) and generate `postgres.env` plus `dsn` as mode 0600 files; do not put values in shell history or Git. The local PG container must bind `127.0.0.1:55490:5432`, mount private `pgdata` at `/var/lib/postgresql` (PG 18 path), and use only synthetic data. `SPIKE90_PG_DSN_FILE` points to the private DSN file.

```sh
mkdir -p /tmp/ningbo-perf-83-90/postgres-poc
chmod 700 /tmp/ningbo-perf-83-90/postgres-poc
cp scripts/spike-90/{poc.py,runner.py,compare_public.py} /tmp/ningbo-perf-83-90/postgres-poc/
```

Create the private password files without printing credentials:

```sh
PYTHONUTF8=1 uv run python - <<'PY'
from pathlib import Path
from secrets import token_urlsafe
from urllib.parse import quote
root = Path('/tmp/ningbo-perf-83-90/postgres-poc')
password = token_urlsafe(32)
(root / 'postgres.env').write_text('POSTGRES_USER=spike90_owner\nPOSTGRES_DB=spike90\nPOSTGRES_PASSWORD=' + password + '\n')
(root / 'dsn').write_text('postgresql://spike90_owner:' + quote(password, safe='') + '@127.0.0.1:55490/spike90')
for name in ('postgres.env', 'dsn'):
    (root / name).chmod(0o600)
PY
```

Start only the isolated container, then wait for `pg_isready`. Run the two `poc.py` servers in separate terminals; their `uv` PEP 723 block installs dependencies into uv's cache, not the global interpreter. After both `/health` endpoints respond, run `runner.py`. It writes only aggregate synthetic results to private JSON. On repeated runs pass a new `--run-id`; the default uses a timestamp.

```sh
mkdir -p /tmp/ningbo-perf-83-90/postgres-poc/pgdata
docker run --rm --name ningbo-spike-90-pg \
  --env-file /tmp/ningbo-perf-83-90/postgres-poc/postgres.env \
  --mount type=bind,src=/tmp/ningbo-perf-83-90/postgres-poc/pgdata,dst=/var/lib/postgresql \
  -p 127.0.0.1:55490:5432 -d postgres:18
docker exec ningbo-spike-90-pg pg_isready -U spike90_owner -d spike90
PYTHONUTF8=1 uv run /tmp/ningbo-perf-83-90/postgres-poc/poc.py sqlite \
  --port 55491 --sqlite-path /tmp/ningbo-perf-83-90/postgres-poc/sqlite.db
SPIKE90_PG_DSN_FILE=/tmp/ningbo-perf-83-90/postgres-poc/dsn \
  PYTHONUTF8=1 uv run /tmp/ningbo-perf-83-90/postgres-poc/poc.py postgres --port 55492
PYTHONUTF8=1 uv run python /tmp/ningbo-perf-83-90/postgres-poc/runner.py \
  --output /tmp/ningbo-perf-83-90/postgres-poc/results.json
```

In this spike, owner-run DDL was followed by an app role without DDL privileges; that server used `--skip-init`. A production design must separately implement migration ownership, credentials, connection pooling, bounded errors, monitoring, backup/recovery and full contract parity. `compare_public.py` is a **prepared** generic public REST sampler for the eventual full app comparison; its prerequisites and missing lanes are in `docs/performance/90/final-comparison.md`. No large-scale run was made here.
