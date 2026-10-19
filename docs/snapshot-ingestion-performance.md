# #88 investigation and #94 frozen ingestion scenario

Frozen before implementation, 2026-10-19. Worktree `t3/perf-spec-81-89-ingestion`
is based on integration `39fb7ba` (contains #83 candidate
`57cc58ac9a410a4e7f3f973982a9b069bb284832`). Parent #81/#82/#88 and #19 live issue
bodies/comments read; comments empty at freeze. Shared frozen baseline:
`/tmp/ningbo-perf-81-89/baseline.md`, source `d198a09`.

## Investigation and ownership

No common narrow processing seam exists. Roster import shares a transaction planner;
OCR has its own per-page workers, file-level Promise.all and page cache; parsing and
Excel exports have separate readers and workbook buffers. A shared abstraction would
combine unrelated contracts. Before code changes, split into:

- [#93 files/OCR/parse/Excel export follow-up](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/93).
  Tracker for independent slices, no implementation in this branch. #88/#91 final
  acceptance remains dependent on those deliveries; Excel read models also depend on #84/#86.
- [#94 snapshot ingestion slice](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/94).
  Implemented here within `roster-import.ts`; #82 is its baseline dependency.

#19 is already implemented: `findQueryRow`, `findRelationRow`, `findAliasRow`,
`findDifferenceRow` use all identity columns in WHERE and select only ID. No change
to these helpers or their schema/indexes. Verify the existing gated thousand-query
scale suite and unchanged semantic/API suites rather than reimplementing #19.

Remaining identified hotspot: `planExportSnapshot` loads every export row including
JSON raw_fields and filters in JS; planning uses nested some over those rows.
`writeExportSnapshot` already uses 200-row inserts, but has no encoded-byte bound.

## Frozen scenario and public seams

Use real SQLite and actual public import preflight/commit and source readback HTTP;
also exercise built Nitro `/mcp` tools/list/tools/call (preflight_roster_batch,
save_roster_batch and source readback). Existing public schema, auth and result shape
remain unchanged. No UI change. No new schema/migration; #87 owns those.

Fixed input: up to 300 snapshot rows, existing snapshot (same SHA under another key),
mixed existing/new rows, new version replacing latest, empty input, Unicode/whitespace
raw_fields and one raw item larger than 1MiB. Preserve source row numbers, JSON values,
returned written IDs/order, add/update counts, rowsWritten, skipped and history pointers.
Second-chunk injected failure must roll back all business rows; repaired retry with
same key succeeds; lost-response replay must return the original receipt without duplicates.
Announcement preflight-plan binding and row error tests remain unchanged and run.

Bound input-key reads in groups of 200; select only needed row numbers for that batch.
Inserts sequentially encode at most 200 rows / 1MiB raw+scalar UTF-8 parameter bytes.
One larger row is a complete one-row statement; never truncate. No parallel chunk queue,
no transaction split, no shared cache. Serialize raw JSON once per pending row and
bind that text directly. Whole HTTP/MCP input still materializes under existing contract;
this slice cannot promise arbitrary single-row/request sizes or fairness during an
arbitrarily large synchronous transaction. #93 covers separate processing paths.

## Frozen budgets and measurement

Inherit #82 unchanged: Node max-old-space-size=2048, one worker; concurrency 1/2/5.
Preflight p95<=3s/p99<=6s, commit p95<=5s/p99<=10s, incremental heap<=256MiB;
no OOM, process heap<1.8GiB/RSS<3GiB. Interactive loop p95<100ms/max<500ms;
fixed-page read p95<=500ms/p99<=1s, response<=256KiB, heap increment<=64MiB.
The 1vCPU/4GiB deployment envelope is not equivalent to this unrestricted local host.

Before/after use identical synthetic input atop separate private copies of the #82
full snapshot. NEVER open that shared snapshot writable or migrate it. For 2x/5x
unrelated export data, generate synthetic raw rows at the measured distribution;
do not copy private content into fixtures, logs or Git. Read traffic: platform summary
page25 concurrently with snapshot preflight/commit and readback. Cold = new server
process, OS cache not purged; warmup then 20 hot samples per concurrency. Quantiles
are observational at this sample size. Report response/input bytes, SQL materialization
and JSON decode/encode where instrumentable, residual explicitly, peak heap/RSS,
event loop delay, DB/WAL sizes and exact source SHA. Public performance numbers are
separate from helper-level diagnostics and synthetic fault tests. No production I/O.

Results and unrun lanes will be appended after verification.
