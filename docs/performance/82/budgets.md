> **Acceptance v2 (2026-10-21):** Future acceptance interpretation is versioned in [acceptance-v2.md](acceptance-v2.md) and [per-issue-disposition.md](per-issue-disposition.md). The frozen v1 history below is preserved verbatim; its misses and unrun lanes are not rewritten as passes.

# #82 shared baseline — frozen before measurement

Frozen 2026-10-19, source d198a09f5a6fab2d5358d442d1b6ce47670c7506; branch t3/perf-baseline-spike-82 equals parent t3/implement-spec-81-89. Scope: investigation/scripts/docs only. #81/#82/#19 read via gh including comments (none); #19 OPEN remains unchanged. No production HTTP requests, load or writes. Only isolated DB copies; all original content and credentials outside Git.

## SLO v1 (targets, not current guarantees)
Node --max-old-space-size=2048; 1 worker; concurrency 1/2/5; host resources recorded. Target controlled deployment envelope 1 vCPU, 4 GiB RSS; local machine runs are explicitly NOT container-limited equivalence. Hard limit no OOM, heap < 1.8 GiB, RSS < 3 GiB; event-loop p95 <100ms / max <500ms for interactive traffic. At 1x/2x/5x unrelated data, fixed-ID and fixed-page incremental heap must stay <=64MiB and not linearly track raw bytes.
- Lists (platform/enterprise/correspondence/source catalog), page <=50: p95 <=500ms, p99 <=1s, response <=256KiB, incremental heap <=64MiB. Stable sort/deep page same budget.
- Single enterprise/event/relation/query ID: p95 <=750ms, p99 <=1.5s, incremental heap <=64MiB excluding explicitly requested raw body; raw-body cap: <=2x body bytes +64MiB.
- Comparison/candidates scoped <=100 records: p95 <=2s, p99 <=4s, heap delta <=128MiB, response <=2MiB.
- Preflight/commit <=300 rows: p95 <=3s/5s, p99 <=6s/10s; heap delta <=256MiB; correct transaction/idempotency required. No shared cache before commit.
- Full-scope aggregation/rebuild/export/OCR local parse: <=60s per 10k rows (OCR external service excluded), working heap <=256MiB; no interactive request blocked >500ms. Files should stream; explicit raw retrieval measured separately.
Samples: cold=fresh Node/app process (OS cache not purged); hot=warmup then repeated rounds. Report sample count and p50/p95/p99, never infer reliable tails from tiny samples. SQL driver timing includes row materialization; parsing/aggregation/serialization/loopback transfer measured separately where instrumentation supports it; residual reported, not invented.

## Initial ownership/call chains
- #83 REST platform-queries -> listPlatformQueries -> full query rows/raw -> JSON parse -> filter/slice; MCP shares roster read helper.
- #84 enterprise list/detail -> readSnapshot -> whole tables -> projections/aggregation.
- #85 correspondence list/candidates/commit -> correspondence helpers; distinguish scoped candidates from full list reads.
- #86 sources/comparison -> source descriptors/snapshots -> raw queries; explicit IDs must be measured for unrelated data growth.
- #87 schema/index/constraints -> db/schema.ts + migrations + EXPLAIN; owns migrations across other tickets.
- #88 processing -> import/preflight, files/OCR/parser/task/export paths; #19 keyed query/relationship lookups must be verified, not reimplemented.
- #89 cache -> actual server/client cache keys, no-store, invalidation and credential isolation.
- #90 PostgreSQL separate PoC; #91 final public HTTP/MCP and UI acceptance. #82 not acceptance of those lanes.

Data acquisition/distributions and results pending. Stop if local copies cannot be established safely; use declared synthetic data and disclose distribution limits. This file is the shared pointer; durable report/scripts will be committed.

## Isolated full distribution acquired
Stable source main/WAL capture (source files only read, no source SQLite connection), SHA256 equality before private WAL recovery + SQLite online backup within private staging. `integrity_check=ok`, FK violations=0. Final isolated DB `/tmp/ningbo-perf-81-89/evidence82/full-snapshot/roster.db`; private provenance beside it. Counts: enterprises 7297, records 20473, events/evidence 21700, queries 39303, relations 58310, export rows 10021, OCR rows 408. File 1,342,353,408 bytes. Query raw_response nonnull31810, total902336692B, p50 25618/p95 62490/p99 80254/max104919B. Relation raw_fields total265951153B, p50 5394/p95 5456/p99 5561/max5904B. Full aggregate distribution `/tmp/ningbo-perf-81-89/evidence82/distribution.json`. Snapshot contains private data and MUST NOT be committed or uploaded. Hardware Apple M4 10 CPU/24GiB, Node24.22.0; local harness heap2048MiB, NO cgroup/container equivalence claim.
