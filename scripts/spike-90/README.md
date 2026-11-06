# #90 isolated synthetic PoC

## Status and entry map (#541)

This is a **status clarification, not retirement**. All twelve files remain: retained test dependencies and historical reproduction sources have different roles. External/manual operator usage is **UNKNOWN**; this note establishes neither current operational use nor safe future deletion. It does not complete work package #519, spec #516 or final acceptance #524.

| Entry | Retained role and concrete consumer |
| --- | --- |
| [poc.py](poc.py), [runner.py](runner.py) | Historical synthetic PoC server/runner pair, used by the original commands below; not the application or its production MCP transport. |
| [compare_public.py](compare_public.py), [test_compare_public.py](test_compare_public.py) | Reusable public JSON comparator with CLI fixture tests (manual unittest command below). `workload_control.py` also imports `run_case`, `request` and `canonical` at module load, including when invoked for fixture derivation. |
| [workload_control.py](workload_control.py), [prepare_sqlite.mjs](prepare_sqlite.mjs), [workload.py](workload.py) | Current repository fixture-test chain: `migrate-copy`/`scale2x` call the Node helper; the controller imports `readonly`/`fingerprint_rows` from `workload.py`. This limited consumer does not validate the historical measurement commands. |
| [workload.Dockerfile](workload.Dockerfile), [workload_oracle.mjs](workload_oracle.mjs), [workload_ops.py](workload_ops.py), [test_workload.py](test_workload.py) | Historical retained-workload build/oracle/storage/restore and adapter regression sources. The Dockerfile runs `workload.py` import/serve; the controller orchestrates preparation/measurement; ops imports workload fingerprint helpers. `test_workload.py` exercises the adapter. |
| This README | Historical manual entry and current status map. |

The default discovery path is [package.json](../../package.json) `test: vitest run` → [vitest.config.ts](../../vitest.config.ts) `tests/**/*.test.ts` → [spike90-fixture-preparation.test.ts](../../tests/spike90-fixture-preparation.test.ts) → controller `migrate-copy`/`scale2x` → Node helper, with the comparator/workload imports above. The two Python test files are **not** discovered by that Vitest pattern. This is source-traced dependency evidence, not a fresh test result or a claim about operator activity.

Historical reproduction is pinned to source commit **`96a0bd9c21d6c0ac32f0de45daf44b76bbda99e6`**. See the [retained-workload runbook](../../docs/performance/90/retained-workload.md), [final results and limitations](../../docs/performance/90/final-96a-results.md) and [recorded source hashes](../../docs/performance/90/final-96a-results.json). Before this note, all twelve directory files matched that commit; unchanged source identity alone does not establish current compatibility or artifact availability. The final cold-process run also used the private execution harness documented in the runbook, not just the checked-in controller.

Do not treat the historical commands/oracle as current application instructions:

- The runbook names historical `0025_platform_query_title_scope_83.sql`; the current tracked migration and fixture-test input are [0027_platform_query_title_scope_83.sql](../../db/migrations/0027_platform_query_title_scope_83.sql).
- [db/client.ts](../../db/client.ts) validates the latest migration hash/time and required tables even for readonly opening. `prepare_sqlite.mjs` executes supplied SQL directly without maintaining the Drizzle migration receipt: fixture derivation is **not application initialization**. The oracle imports the checkout's actual DB client/read functions; its fixed baseline hash is provenance, not a compatibility guarantee.
- Current [schema metadata](../../db/schema.ts) includes `lastCollectedAt`, returned by the [summary reader](../../lib/platform/read.ts); the historical adapter's `META`/`CAMEL` omit it. Even a current row with a null value differs in shape. This is a static incompatibility finding, not a newly observed runtime failure.

No replacement migration recipe or validation bypass is supplied. Historical commands, receipts, hashes, FAIL/UNKNOWN and UNRUN boundaries remain unchanged; later results do not erase earlier failures. For this documentation slice, all runtime lanes are **UNRUN**: scripts, installs, tests, builds, Docker, DB, HTTP/MCP, benchmarks, browser, CI and production. Historical results remain inherited evidence, not fresh acceptance.

## Original historical instructions (preserved)

Source only. Python dependencies are pinned to the versions used in the PoC (`psycopg`/binary 3.3.6 and pool 3.3.3). Copy these files to `/tmp/ningbo-perf-83-90/postgres-poc` before running; keep generated DB, PGDATA, secrets, backups and results there. `poc.py` rejects an SQLite path outside that directory. It models a tiny batch/source/relation/audit chain over public local HTTP and MCP-like JSON-RPC calls. It is **not** the production application or a PostgreSQL migration.

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
  -p 127.0.0.1:55490:5432 -d postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a
docker exec ningbo-spike-90-pg pg_isready -U spike90_owner -d spike90
PYTHONUTF8=1 uv run /tmp/ningbo-perf-83-90/postgres-poc/poc.py sqlite \
  --port 55491 --sqlite-path /tmp/ningbo-perf-83-90/postgres-poc/sqlite.db
SPIKE90_PG_DSN_FILE=/tmp/ningbo-perf-83-90/postgres-poc/dsn \
  PYTHONUTF8=1 uv run /tmp/ningbo-perf-83-90/postgres-poc/poc.py postgres --port 55492
PYTHONUTF8=1 uv run python /tmp/ningbo-perf-83-90/postgres-poc/runner.py \
  --output /tmp/ningbo-perf-83-90/postgres-poc/results.json
```

In this spike, owner-run DDL was followed by an app role without DDL privileges; that server used `--skip-init`. A production design must separately implement migration ownership, credentials, connection pooling, bounded errors, monitoring, backup/recovery and full contract parity. `compare_public.py` is a **prepared** generic public REST sampler for the eventual full app comparison; its prerequisites and missing lanes are in `docs/performance/90/final-comparison.md`. No large-scale run was made here.

The recorded image digest runs PostgreSQL 18.4; a mutable `postgres:18` tag may resolve to a newer release. Record a changed digest/version as a new experiment. Never regenerate `postgres.env` against an existing initialized PGDATA: image initialization variables do not rotate existing database credentials. Keep old private data and use a new isolated directory/container for a fresh experiment.

The semantic runner exercises concurrent **replay of an already committed key**, not simultaneous first commits of a new key. It does not prove all production idempotency/concurrency invariants. The tiny schema and mock MCP transport cannot replace the application's actual receipt/fingerprint or initialized Streamable HTTP MCP tests.

Comparator verification (CLI against local synthetic HTTP fixtures):

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1 uv run python -m unittest discover \
  -s scripts/spike-90 -p 'test_compare_public.py' -v
```

The comparator rejects empty manifests, gates all non-GET methods, refuses redirects and retains failed/invalid JSON samples in the report. It exits 2 for semantic/status mismatches. Its wall throughput and percentiles include failed attempts; inspect `failed_samples` before interpreting timings. These fixture tests do not count as actual app or full-scale acceptance.

After verification, stop only the PoC server PIDs recorded for this run and `docker stop ningbo-spike-90-pg`. Retain private evidence and PGDATA; do not use a broad Docker/process cleanup command.
