# #90 retained archive workload — 1x preparation complete; exclusive timing pending

This narrow comparison does **not** require porting the whole application to PostgreSQL. It compares the optimized #83 read algorithm for platform summaries/title filters and exact original evidence/relation discovery on the complete retained query/relation distribution. All original query/relation columns and text bytes are imported; the PostgreSQL side is a separate experimental schema, not an application migration. Other domains remain in the source SQLite copy but are not ported or benchmarked.

The qualified source handoff is private `/tmp/ningbo-perf-83-90/83-fixture-handoff.md`: a quiescent mode-0400 production-backup clone, 1,405,333,504 bytes, SHA-256 `2c72355ebe602b24d9c0a08561957481d97b083a78aae51995e29e58e4064430`, 39,303 queries and 58,310 relations. #90 creates its own independent copy. No source connection is writable. Only after the parent's exclusive grant may the following large copy/import/build/measurement run.

## Algorithm and semantic gate

- `workload.py`: pooled max-five readonly SQLite or PostgreSQL adapters. The optimized title predicate uses the final #83 title membership/error tables and narrow count/time indexes; the same membership data are retained on PG. It preserves direct-title OR scope membership, string-vs-number membership, selected-scope malformed archive errors, all five statuses, stable `queried_at DESC,id DESC`, scoped counts, full relation counts, ordered relation discovery, null/empty distinctions and UTF-8 byte slices.
- `workload_oracle.mjs`: runs actual repository `listPlatformQueries(view=summary)` and `readPlatformQueryEvidence` functions readonly, records source SHA and algorithm file hashes and per-case semantic hashes. The adapters must match this independent oracle before timing. The generic loopback HTTP interface is an experimental read API, not the production API/MCP implementation.
- `workload_control.py`: copies/hash-checks the qualified source, derives an independent optimized copy using the final actual #83 SQL migration, verifies original query/relation row hashes unchanged, prepares cases, optionally creates 2x **synthetic unrelated query/relation archive growth**, and checks actual Docker limits before measurement. 2x preserves original rows, remaps clone primary/query foreign keys and query identity keys, preserves archived raw bytes/embedded identities, and requires derived membership/error counts to double through the actual triggers. It is not a second real production snapshot or full-app 2x dataset.
- The importer streams COPY and ordered verification with a PG server-side cursor (100 rows per fetch), verifies every retained field/ID/raw byte count/hash, creates query foreign keys and required unique/index constraints, and creates a SELECT-only role with `default_transaction_read_only=on`. It refuses to overwrite an existing PG database. Business raw text, DSNs, outputs and images' runtime secret values stay outside Git.

Small synthetic verification before any full run: actual Node oracle and SQLite/PG adapters matched 11 cases; seven literal tests cover five statuses/tie ordering, title JSON types, scoped malformed errors, status/deep/empty pages, relation multiplicity/order, and byte-exact Unicode/null/empty. Provisional #83 migration was used only for the tiny migration/2x rehearsal; the full run must freeze the committed final #83 source and migration hashes.

## Reproducible runbook

Run from this worktree after merging final #83. Use a fresh private directory, and record the source commit and `sha256` of every runner/migration file. Do not regenerate credentials against initialized PGDATA. Commands below must not run concurrently with other benchmarks.

```sh
export SPIKE90_DIR=/tmp/ningbo-perf-83-90/workload/full-1x
PYTHONUTF8=1 uv run python scripts/spike-90/workload_control.py prepare \
  --source /tmp/ningbo-perf-83-current/real-copy.sqlite \
  --source-sha256 2c72355ebe602b24d9c0a08561957481d97b083a78aae51995e29e58e4064430 \
  --qualified-handoff /tmp/ningbo-perf-83-90/83-fixture-handoff.md --directory "$SPIKE90_DIR"
PYTHONUTF8=1 uv run python scripts/spike-90/workload_control.py migrate-copy \
  --source "$SPIKE90_DIR/source.sqlite" --output "$SPIKE90_DIR/optimized.sqlite" \
  --migration db/migrations/0025_platform_query_title_scope_83.sql --report "$SPIKE90_DIR/optimized-provenance.json"
PYTHONUTF8=1 uv run python scripts/spike-90/workload_control.py manifest \
  --sqlite "$SPIKE90_DIR/optimized.sqlite" --output "$SPIKE90_DIR/manifest.json"
NODE_PATH=/Users/mang/.t3/worktrees/app/t3-80399dac/node_modules node scripts/spike-90/workload_oracle.mjs \
  "$SPIKE90_DIR/optimized.sqlite" "$SPIKE90_DIR/manifest.json" "$SPIKE90_DIR/oracle.json" \
  /Users/mang/.t3/worktrees/app/t3-80399dac

docker build -f scripts/spike-90/workload.Dockerfile -t ningbo-spike90-workload-adapter:90 scripts/spike-90
docker network create --internal ningbo-spike90-workload-net
mkdir -p "$SPIKE90_DIR/pgdata"
docker run --rm -d --name ningbo-spike90-workload-pg --network ningbo-spike90-workload-net \
  --cpus .75 --memory 3584m --memory-swap 3584m --env-file "$SPIKE90_DIR/postgres.env" \
  --mount "type=bind,src=$SPIKE90_DIR/pgdata,dst=/var/lib/postgresql" \
  postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a
# Wait for this owned server's pg_isready, not another app/container.
docker exec ningbo-spike90-workload-pg pg_isready -U spike90_owner -d postgres
docker run --rm --network ningbo-spike90-workload-net --cpus .25 --memory 512m --memory-swap 512m \
  --mount "type=bind,src=$SPIKE90_DIR,dst=/private" ningbo-spike90-workload-adapter:90 import \
  --sqlite /private/optimized.sqlite --provenance /private/optimized-provenance.json \
  --dsn-file /private/admin.dsn --database spike90_workload_1x --reader-dsn-file /private/app.dsn --output /private/import.json

docker run --rm -d --name ningbo-spike90-workload-sqlite --network ningbo-spike90-workload-net \
  --cpus 1 --memory 4096m --memory-swap 4096m \
  --mount "type=bind,src=$SPIKE90_DIR,dst=/private,readonly" ningbo-spike90-workload-adapter:90 serve \
  --backend sqlite --sqlite /private/optimized.sqlite --host 0.0.0.0 --port 8080
docker run --rm -d --name ningbo-spike90-workload-client --network ningbo-spike90-workload-net \
  --cpus .25 --memory 512m --memory-swap 512m \
  --mount "type=bind,src=$SPIKE90_DIR,dst=/private,readonly" ningbo-spike90-workload-adapter:90 serve \
  --backend postgres --dsn-file /private/app.dsn --host 0.0.0.0 --port 8080
# Docker 29 internal-only bridges did not publish requested host ports in this run.
# Keep the private internal network; use the same controlled observer for both services.
docker run --rm -d --name ningbo-spike90-workload-sampler --network ningbo-spike90-workload-net \
  --cpus 1 --memory 512m --memory-swap 512m \
  --mount "type=bind,src=$PWD/scripts/spike-90,dst=/source,readonly" \
  --entrypoint sleep ningbo-spike90-workload-adapter:90 infinity
PYTHONUTF8=1 uv run python scripts/spike-90/workload_control.py measure \
  --manifest "$SPIKE90_DIR/manifest.json" --oracle "$SPIKE90_DIR/oracle.json" --output "$SPIKE90_DIR/comparison.json" \
  --sqlite-container ningbo-spike90-workload-sqlite --postgres-container ningbo-spike90-workload-client \
  --pg-container ningbo-spike90-workload-pg --sampler-container ningbo-spike90-workload-sampler \
  --sqlite-url http://ningbo-spike90-workload-sqlite:8080 --postgres-url http://ningbo-spike90-workload-client:8080 --samples 20
```

The PG cluster receives no host port. Both HTTP adapters and the observer use the exact same built image. The observer is a separate identical HTTP client for A/B, constrained to 1 CPU/512 MiB outside the total service envelopes; its actual limits and sampled CPU/RSS are retained. The client is part of throughput/HTTP observation overhead, not attributed to either database engine. Actual inspect records must show SQLite CPU=1/RSS=4096MiB; PG client=.25/512MiB plus DB=.75/3584MiB, total=1 CPU/4096MiB. This is an equal **total envelope workload** comparison; component allocation, IPC, drivers/pooling and DB cache costs still differ. It cannot isolate pure-engine ranking. Report component RSS/CPU/IO and PG/SQLite/WAL/backup disk costs, not only Python RSS. `docker stats` is supplementary; peak usage must come from in-run samplers/cgroup peak files, not after-the-fact idle values.

Each case restarts its adapter process and alternates which backend runs first; `/health` does not perform the measured query. Database/OS caches are retained: “cold” means first measured request in a fresh process. Every c1/c2/c5 sample and failure is retained; percentiles include failed attempts and never stand alone as success SLOs. Response headers retain SQL driver+materialization time/count/returned bytes, total read/shaping time, serialization and process high-water RSS. The remaining difference to HTTP wall time is not silently called network time. There is no Node heap/event-loop observation in this Python experiment.

For 2x, use `scale2x --source <optimized1x> --output <new2x.sqlite> --report <new2x-provenance.json>`, generate a new manifest/oracle on that exact copy, import to a NEW `spike90_workload_2x` database and repeat with the same actual limits. No raw output or embedded identity is rewritten to fake a second genuine domain history. Other-domain/mixed-write/long-duration/5x lanes remain separate if not executed.

Stop only `ningbo-spike90-workload-sqlite`, `ningbo-spike90-workload-client`, `ningbo-spike90-workload-pg`, and `ningbo-spike90-workload-sampler`, then remove only `ningbo-spike90-workload-net`. Retain all private source copies/PGDATA/provenance/output; never use broad Docker cleanup.


## Qualified 1x preparation (shared host, not timing evidence)

On runner source `8247cb4` plus the committed observer transport correction, the independent source copy matched the qualified hash. Applying final #83 migration `0025` left all original query/relation field/row hashes unchanged. The importer retained and verified complete rows of the two original and two derived tables, and confirmed its SQLite source hash remained unchanged. The final actual Node oracle has nine workload cases; single reads from each Docker backend must match all nine hashes before timing. Exact driver/runtime/configuration and image/source hashes are private `preparation-semantic.json`, and domain storage is `storage.json`.

Retained setup failure: host `127.0.0.1:55493` refused connection even though Docker `HostConfig.PortBindings` contained the mapping; actual `NetworkSettings.Ports` was empty. The same running adapter answered `/health` inside its container. The source fix uses a same-image observer on the private internal bridge; it neither relaxes the bridge nor changes global Docker networking. This setup failure does not count as a workload latency sample or a successful availability result.

`workload_ops.py storage` compares the same four tables/indexes via SQLite `dbstat` and PostgreSQL `pg_total_relation_size`, while separately retaining whole-file/database and cluster WAL allocation. These are private synthetic-domain/retained-domain costs; the complete SQLite file also contains unported domains. The `verify` action streams all four PostgreSQL table hashes after a separate restore and can compare them with `import.json`; it never aggregates raw archives into one SQL result.
