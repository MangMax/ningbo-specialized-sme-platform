# #88 investigation and #94 frozen ingestion scenario

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


Delivery note: earlier cohorts below are preserved historical evidence. The final
source binding and gate exit codes are in the private `final-verification.json`;
see the final qualification section for current results and remaining gaps.

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

## Implementation and semantic evidence

Code candidate `b511a7a87a3f2f44ad0185d6ca1cb9f212c4ada1`, instrumentation fix
`ee1b202ae3175c0ef82342f8c838662411952fe4`. The latter uses the built artifact's
SQLite module, rather than the development module (their Statement prototypes differ).
Integration `bf0efc6` was subsequently merged as `5ca3a5a`; only #89 docs/scripts
changed, with no server/lib/db/config/dependency diff from the measured app source.

The implementation reads snapshot identity/latest IDs in SQL, and only input source
row numbers in groups of 200. It never materializes archived export raw_fields during
planning. Writes encode JSON once into bound SQL parameters, flush synchronously at
200 rows or 1MiB, and isolate an oversize row. All flushes remain inside the existing
transaction. Written IDs are sorted by row ID to retain the previous receipt order.
No import ledger, announcement plan binding, public contract, migration or cache change.

Tests in `tests/snapshot-ingestion-resources.test.ts`:

- `snapshot HTTP import bounds encoded statements and preserves oversized raw items and receipt replay`:
  SQL-driver statement byte/count telemetry supplements public HTTP preflight, commit,
  exact Unicode/nested/whitespace raw readback and same-key/other-key replay assertions.
- `snapshot HTTP failure in a later chunk rolls back earlier rows and same-key retry returns a durable receipt`:
  a private-fixture SQLite trigger aborts row203 after the first200-row chunk;
  source readback is404, repaired retry keeps the batch ID and writes301 rows once.
- `snapshot HTTP versions retain previous history and empty and mixed rows retain their counts`:
  version predecessor, untouched old source, mixed existing/new, empty and duplicate-row errors.
- `snapshot preflight does not materialize unrelated archived raw fields` (opt-in
  `ROSTER_SNAPSHOT_SCALE=1`): 1100 unrelated300kB JSON rows, public preflight300 rows.
  Before change: heap growth634,478,240B >268,435,456B, red. After: passes the same bound.
  The byte-chunk regression also went red first (one statement for all9 large rows),
  then green before the read projection fix. Existing test files were not modified.

Private evidence root `/tmp/ningbo-perf-81-89/88/`:
`red-statements.log`, `red-resource.log`, `green-statements.log`, `green-resource.log`,
`focused-tests.log`, `verify19.log`, `typecheck.log`, `after-build.log`.
Baseline semantic/API tests107 passed; candidate focused tests110 passed/1 scale skipped;
#19 existing opt-in thousand-query suite4 passed. Typecheck and build exited0.
Initial whole suite:2074 passed/1 existing timeout/12 skipped, not a green suite.
The timeout was the unchanged version-replacement test at line2792; its focused rerun
passed in54ms without changing its5s timeout (`timeout-recheck.log`).

## First complete before/after public comparison

These are observed numbers, **not a frozen-budget pass**. Both use the full private
snapshot plus150 synthetic existing rows (10171 export rows/48,759,858 raw bytes),
the same300-row input (383,788B), one concurrent summary-page25 reader and one writer.
One cold round, one warmup,20 hot rounds. Each round preflights, commits150 new rows,
reads exact synthetic raw/source row number, and replays the same key to assert the
identical receipt. Cold also compares real MCP source readback with HTTP.

Before (`3bbe828`, built app code39fb7ba), cold preflight/commit22,107/11,203ms;
hot preflight p50/p95/p99=390/10,015/19,646ms;
commit411/9,877/11,369ms; read67/8,989/19,102ms.
Heap peak638,206,264B, incremental486,462,376B (463.9MiB), sampled RSS499,793,920B;
loop p95/max1874.9/19109.2ms. Aggregate hot JSON parse4050ms, stringify7.6ms.
SQL telemetry for this baseline did **not** attach to the artifact driver: SQL timing,
row and byte counters are unavailable, not zero. Earlier v1/v2 connection-reset runs
and v3 heavy RSS-sampling run are incomplete diagnostics, excluded from comparison.

After (`ee1b202`, built app codeb511a7a), cold7196/620ms;
hot preflight325/8403/11346ms; commit336/2347/18208ms;
read263/8394/18155ms. Heap peak79,017,496B, incremental30,121,960B (28.7MiB),
sampled RSS214,777,856B; loop p95/max1926.2/18169.7ms.
Aggregate hot SQL (including native row materialization and byte-count instrumentation)
56,728ms,14,300 returned rows/148,196 text bytes; JSON parse136ms/stringify11.8ms.
These aggregate counters cover all mixed requests, source readback and receipt replay;
they cannot attribute time to individual endpoints or separate aggregation from transfer.
Do not invent a residual breakdown from overlapping client requests.

Both responses: preflight178B, commit1135B, summary page7344B. DB before1,342,574,592B,
after1,345,695,744B, WAL4,255,992B. Same input/result invariants hold; server-generated
timestamps and IDs are checked for source/order/receipt consistency rather than compared
across independently seeded processes. Before was stopped after the first complete
budget-failing run; remaining before matrix is unrun, including2x/5x. In-flight work
was discarded. Complete per-run evidence: `before-public-v4/1x-http-r1.json` and
`after-public/1x-http-r1.json`.

After reduced memory and JSON work, but mixed traffic still fails preflight/read p95,
commit/read p99 and event-loop budgets. No claim that the processing acceptance or
parent#88/#91 is complete. Additional concurrency/scale observations follow below.

## Pre-#87 after matrix and acceptance gaps

All18 scenarios completed, each with one cold round, one warmup and20 hot rounds.
Every round checked150 existing+150 new rows, exact raw/source-row readback and same-key
receipt identity; cold rounds also checked source HTTP=MCP. The public transports
actually executed tools/list and tools/call, rather than a mocked tool handler.

| Export scale | Transport | Concurrent readers (+1 writer) | Preflight p50/p95/p99 ms | Commit p50/p95/p99 ms | Read p50/p95/p99 ms | Mixed heap delta MiB | Loop p95/max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1x | HTTP | 1 | 325/8403/11346 | 336/2347/18208 | 263/8394/18155 | 28.7 | 1926/18170 |
| 1x | HTTP | 2 | 226/2131/27662 | 232/480/835 | 167/1341/27652 | 8.3 | 619/24394 |
| 1x | HTTP | 5 | 393/5239/5708 | 444/2253/3818 | 261/3816/5559 | 24.9 | 568/5331 |
| 1x | MCP | 1 | 91/157/9037 | 121/197/1167 | 86/148/8989 | 20.6 | 139/8984 |
| 1x | MCP | 2 | 202/2015/4169 | 189/648/1661 | 131/1294/4170 | 57.6 | 298/4165 |
| 1x | MCP | 5 | 281/714/1380 | 291/457/2280 | 209/707/2124 | 60.2 | 190/1730 |
| 2x | HTTP | 1 | 47/52/52 | 51/58/58 | 43/50/57 | 11.7 | 53/60 |
| 2x | HTTP | 2 | 131/193/309 | 128/259/457 | 113/203/442 | 8.3 | 140/380 |
| 2x | HTTP | 5 | 320/495/2475 | 311/464/643 | 231/433/2384 | 3.3 | 214/1158 |
| 2x | MCP | 1 | 60/69/73 | 68/85/95 | 55/69/70 | 43.9 | 72/75 |
| 2x | MCP | 2 | 104/148/162 | 118/143/146 | 87/123/156 | 39.3 | 71/118 |
| 2x | MCP | 5 | 378/1424/2766 | 408/585/588 | 272/589/2584 | 15.7 | 249/2221 |
| 5x | HTTP | 1 | 67/133/139 | 77/146/196 | 62/126/131 | 10.8 | 95/133 |
| 5x | HTTP | 2 | 143/200/229 | 152/338/342 | 115/227/336 | 12.7 | 131/258 |
| 5x | HTTP | 5 | 344/633/684 | 338/587/782 | 275/468/643 | 3.9 | 267/463 |
| 5x | MCP | 1 | 111/180/773 | 110/256/781 | 93/159/765 | 24.9 | 150/767 |
| 5x | MCP | 2 | 151/753/8449 | 218/1507/1804 | 127/655/7177 | 16.5 | 239/7072 |
| 5x | MCP | 5 | 486/785/4402 | 467/1521/2342 | 280/877/2055 | 13.5 | 341/4068 |

Mixed hot heap increments3.3–60.2MiB, all below256MiB, with no linear increase
as unrelated export raw bytes grew48,759,858 →97,334,445 →243,058,206B.
Maximum observed process heap across cold/hot121.96MiB, OS peak RSS348.67MiB;
all18 processes retained the2048MiB old-space setting and completed without OOM.
These are mixed-process measurements, not independent attribution of read-only heap.

Strictly applying both p95/p99 write budgets:5/18 scenarios fail; read latency10/18
fail; interactive event-loop p95/max14/18 fail. Memory improvement does not satisfy
those missing latency gates. Do not infer cause or stable tail guarantees from20
samples: the unrestricted local host was concurrently used by other work, and cold
OS caches/SQLite freelists were not normalized. The DB logical fixture was reset
between fresh processes within each scale; freelist/page layouts can differ.
Other full-snapshot tables stay1x:2x/5x only scale unrelated export rows/text, with
synthetic strings matching the measured original length distribution. Container
1vCPU/4GiB, full-database2x/5x, independent per-read heap, file/OCR/parse/Excel
processing (#93), UI, production and parent#91 acceptance are unrun.

Full per-run cold/hot, SQL/JSON counters, response bytes and DB/WAL sizes:
`/tmp/ningbo-perf-81-89/88/after-public/results.json`.
The shared snapshot was never opened by SQLite: only filesystem copies were opened,
and source size/mtime were unchanged on completion. Saved credentials were deleted
from each owned copy without reading values. No raw private rows or credentials
appear in committed artifacts or telemetry. Response summaries are observations,
not business classifications.

## Actual process interruption recovery

`node scripts/verify-snapshot-ingestion-recovery.mjs` passed against the built
artifact, real HTTP/MCP, and a new private synthetic SQLite DB. A driver-boundary
fault hook pauses immediately after the first200-row INSERT while its transaction
is open; the parent SIGKILLs only that owned child. After restart, source ID1 is404,
same-key MCP preflight keeps the original import batch ID, and MCP commit writes
all300 rows+one snapshot batch. Exact raw/source row numbers are checked at both
sides of the chunk boundary. HTTP replay is identical, and remains identical after
a second server restart. This supplements the ordinary second-chunk SQL-abort test;
it does not simulate a crash between business COMMIT and ledger receipt persistence.
Evidence: `/tmp/ningbo-perf-81-89/88/process-recovery.log`.

Reproduction (local only, build first; provide a new private output directory):

```sh
node scripts/bench-snapshot-ingestion.mjs /absolute/private/snapshot.sqlite /tmp/new-private-run <source-sha> 1,2,5 http,mcp 1,2,5
node scripts/verify-snapshot-ingestion-recovery.mjs
ROSTER_SNAPSHOT_SCALE=1 NODE_OPTIONS=--max-old-space-size=2048 pnpm vitest run tests/snapshot-ingestion-resources.test.ts
ROSTER_IMPORT_SCALE=1 pnpm vitest run tests/roster-import-scale.test.ts
```

The benchmark uses connection:close to avoid stale keep-alive socket resets, lightweight
V8 heap sampling and sampled RSS; timing remains instrumented and includes probe cost.
SQL timings include driver materialization and counting returned string bytes; JSON
parse/stringify are separately timed. No claim of separately measured aggregation
or transfer residual. A final verification run bound to the delivery SHA is recorded
outside Git in `/tmp/ningbo-perf-81-89/88/final-verification.json` and sibling logs.
No PR, issue closure, main/production write or ticket-owned schema/migration change.

## Integration refresh after #87

While finalizing, integration advanced to `71cc7bf351523c3ac5b9a4eb892cc362dcf0d189`
with #87 indexes; merged here as `f7fd93ec43a9a964b06109ad64030762eae09e06`.
`0013_nappy_dreadnoughts.sql` and schema changes are inherited #87 work, not authored
by this ticket. The prior18-run matrix stays historical and cannot establish the
new HEAD's latency gates. Rebuild and a new complete public cohort on private copies
are required; its evidence is recorded in `after-integrated-public/` under the same
private evidence root. No shared snapshot is migrated.

Before running the large-request performance lane, freeze its concrete input under
the already-frozen300-row/oversize-item scenario:300 raw objects,299 at14,753B
(the measured export p99) and the first new row at1,200,000B. HTTP and MCP,5 readers
+1 writer,1x full private snapshot, one cold/one warmup/20 hot rounds. Reuse every
frozen latency/heap/loop budget unchanged. `large` is an explicit benchmark mode;
the representative baseline/comparison input is unchanged. Whole-request JSON
materialization remains in scope for measurement; no streaming contract is claimed.

## Current integrated cohort

Measured commit `e2239c0582f411ed10868741f7dc2b0555ef2592`; rebuilt app source
`f7fd93ec43a9a964b06109ad64030762eae09e06` (the intervening commit only added
recovery verification and a test assertion). #87 migrations apply on owned copies
only. This is a new cohort; do not attribute its full latency improvement to#94 alone.

| Export scale | Transport | Readers (+1 writer) | Preflight p50/p95/p99 ms | Commit p50/p95/p99 ms | Read p50/p95/p99 ms | Mixed heap delta MiB | Loop p95/max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1x | HTTP | 1 | 9/14/15 | 16/26/49 | 5/10/47 | 11.5 | 22/49 |
| 1x | HTTP | 2 | 12/17/17 | 15/27/35 | 6/16/33 | 12.6 | 20/32 |
| 1x | HTTP | 5 | 19/32/38 | 23/37/41 | 14/28/33 | 9.5 | 24/34 |
| 1x | MCP | 1 | 9/15/15 | 15/25/26 | 5/15/25 | 41.2 | 20/25 |
| 1x | MCP | 2 | 10/14/14 | 15/23/29 | 5/12/29 | 42.4 | 17/28 |
| 1x | MCP | 5 | 15/21/21 | 18/31/34 | 8/19/22 | 37.0 | 20/28 |
| 2x | HTTP | 1 | 7/10/13 | 11/18/56 | 4/7/14 | 17.3 | 17/49 |
| 2x | HTTP | 2 | 7/13/14 | 11/20/22 | 4/11/18 | 17.7 | 18/18 |
| 2x | HTTP | 5 | 12/23/43 | 18/30/30 | 8/20/22 | 6.9 | 18/25 |
| 2x | MCP | 1 | 7/9/10 | 11/16/21 | 3/5/9 | 42.2 | 16/24 |
| 2x | MCP | 2 | 10/15/18 | 18/25/35 | 5/16/25 | 45.9 | 25/25 |
| 2x | MCP | 5 | 15/19/21 | 21/31/59 | 10/20/29 | 36.2 | 24/59 |
| 5x | HTTP | 1 | 16/59/64 | 40/160/166 | 8/65/132 | 16.4 | 46/118 |
| 5x | HTTP | 2 | 22/44/61 | 38/109/137 | 13/32/108 | 12.5 | 59/96 |
| 5x | HTTP | 5 | 36/290/351 | 55/309/456 | 13/75/152 | 5.1 | 156/457 |
| 5x | MCP | 1 | 12/35/51 | 16/37/83 | 7/15/25 | 46.5 | 29/75 |
| 5x | MCP | 2 | 20/53/57 | 40/98/100 | 10/50/94 | 42.4 | 48/89 |
| 5x | MCP | 5 | 48/116/143 | 68/128/146 | 20/105/120 | 39.3 | 80/120 |

All18 completed20 hot rounds with identical logical inputs/invariants. Observed hot
preflight p95 max290.43ms; commit p95 max308.78ms; read p95 max105.20ms. All18 meet
both p95/p99 preflight/commit/read latency thresholds, and mixed heap deltas5.1–46.5MiB
are below256MiB. Maximum process heap124.68MiB, OS peak RSS341.81MiB; no OOM.
Cold preflight/commit maxima276.80/194.70ms (one cold sample per scenario, no reliable
cold tail claim). Event-loop max across hot runs456.65ms (<500ms), but **one p95
failure remains**: 5x/http/readers5: loop p95=156.50ms, max=456.65ms. The <100ms target is unchanged; do not label this
cohort fully passed. The independently measured read-only heap and container envelope
remain unrun; low sample count and local-host limitations still apply.

Full evidence: `/tmp/ningbo-perf-81-89/88/after-integrated-public/results.json`. Source file size/mtime unchanged; all temporary
benchmark DB copies removed by the harness on completion. The baseline SQL telemetry
gap remains a gap. No pre-index baseline SQL counter is silently filled using the
new-index run. Source hashes, individual gate exit codes and the final Git HEAD will
be recorded in `final-verification.json` outside Git after the final checks.

## Large request policy and #95

The measured 300-row large HTTP request was5,621,522B, with a1,200,000B raw JSON
single item. On `2d5772c9a4ee064bd418d54d6dad79b613ade225` (app source `c66760d`,
including #85),5 concurrent summary readers +1 writer,20 hot rounds gave preflight
p50/p95/p99=17.12/17.97/23.68ms, commit29.12/67.80/71.76ms,
read4.88/8.15/8.73ms; heap increment52,485,560B, loop max61.31ms.
Full evidence: `after-final-large-http/results.json` under the private evidence root.

The same shape failed its first MCP preflight with HTTP413. This is an observed
unsupported lane, **not passed or merely unrun**. SDK `server/requestBody.js` defaults
to4*1024*1024 bytes; `webStandardStreamableHttp.js` rejects over-limit bodies before
tool dispatch. The private failed fixture had0 synthetic import-ledger rows and0 new
business rows (`after-integrated-large/mcp-413-state.json`).

Do not silently split an atomic batch or increase the transport limit. Retain the
complete payload and idempotency key, then use the existing HTTP endpoint with its
own authorized API credential (HTTP/MCP tokens are distinct in the contract). The
recovery verification now exercises this actual413 → same-key HTTP preflight/commit
→ identical HTTP receipt replay path, and reads the1.2MB singleton back through MCP
exactly. HTTP writes301 rows, confirming the failure did not consume a committed
receipt. Evidence: `final-process-recovery.log`. Whole-request JSON materialization
and arbitrary item sizes are still not bounded by this slice.

[#95 MCP capacity follow-up](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/95)
owns investigation of a bounded large-MCP-batch delivery contract. No limit was raised
here. #93 remains the files/OCR/parse/Excel processing tracker; neither#88 nor#94 nor
the acceptance parent#91 is closed automatically.

Integration subsequently added #82 baseline artifacts and #84 enterprise read changes
through `5c9ab8e`; these are inherited work. Final gates use the synchronized branch,
and named earlier measurements are not relabeled as results of a later commit.

## Delivery qualification (authoritative local cohort)

Built and measured app source `6982676985814bd720d0405295d9bf74d5c039d4`, synchronized
with integration `5c9ab8e482b28b47dbeb7f947f450f40336c86ce` (#82/#83/#84/#85/#87/#89).
This cohort was rerun on the rebuilt artifact; earlier failures are retained above,
not silently reclassified. The ingestion module remains the#94 change fromb511a7a;
combined integration improvements must not be attributed to this ticket alone.

| Export scale | Transport | Readers (+1 writer) | Preflight p50/p95/p99 ms | Commit p50/p95/p99 ms | Read p50/p95/p99 ms | Mixed heap delta MiB | Loop p95/max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1x | HTTP | 1 | 5.0/7.2/7.3 | 8.8/20.5/34.5 | 2.7/4.8/6.8 | 16.6 | 15.8/33.4 |
| 1x | HTTP | 2 | 6.8/9.8/10.4 | 10.5/18.3/19.7 | 3.7/8.6/10.0 | 12.7 | 15.3/23.5 |
| 1x | HTTP | 5 | 10.7/16.4/17.6 | 15.0/18.8/19.0 | 6.6/14.1/18.2 | 5.9 | 14.4/16.2 |
| 1x | MCP | 1 | 5.9/7.9/9.1 | 9.5/18.4/20.2 | 2.6/5.2/10.0 | 47.2 | 14.8/18.6 |
| 1x | MCP | 2 | 8.0/12.2/12.3 | 11.0/21.2/25.7 | 4.0/9.6/20.5 | 42.2 | 15.9/18.0 |
| 1x | MCP | 5 | 11.2/13.5/14.3 | 14.7/21.8/26.9 | 6.0/14.8/20.6 | 33.9 | 16.7/27.0 |
| 2x | HTTP | 1 | 6.3/9.1/10.2 | 11.0/20.2/49.8 | 3.6/7.4/48.5 | 16.6 | 15.0/47.8 |
| 2x | HTTP | 2 | 7.5/15.0/37.2 | 12.5/23.4/28.9 | 4.6/12.1/36.4 | 20.5 | 17.2/37.1 |
| 2x | HTTP | 5 | 11.6/15.2/18.9 | 14.3/21.8/22.6 | 6.7/15.4/18.3 | 8.9 | 14.1/19.9 |
| 2x | MCP | 1 | 6.6/9.2/11.8 | 10.4/15.2/17.8 | 2.8/5.4/7.5 | 34.0 | 15.8/18.6 |
| 2x | MCP | 2 | 7.1/9.8/10.8 | 10.6/15.4/17.1 | 3.5/7.8/10.9 | 37.1 | 14.9/21.1 |
| 2x | MCP | 5 | 12.6/18.4/20.2 | 15.5/22.8/26.7 | 6.7/15.7/19.7 | 32.1 | 18.9/21.3 |
| 5x | HTTP | 1 | 7.8/12.4/35.1 | 14.5/24.6/41.1 | 5.0/11.6/40.4 | 12.0 | 19.2/46.2 |
| 5x | HTTP | 2 | 13.3/27.4/48.7 | 16.2/24.7/25.7 | 6.9/18.4/26.9 | 11.7 | 17.8/22.6 |
| 5x | HTTP | 5 | 14.6/20.1/20.8 | 19.1/26.5/28.3 | 8.7/19.7/26.6 | 49.6 | 17.4/26.6 |
| 5x | MCP | 1 | 7.5/9.9/9.9 | 11.6/16.1/17.9 | 3.5/6.3/13.1 | 33.5 | 17.4/20.5 |
| 5x | MCP | 2 | 7.3/12.7/13.6 | 10.9/16.8/21.5 | 3.8/7.9/9.6 | 44.9 | 13.5/21.6 |
| 5x | MCP | 5 | 14.1/18.2/19.1 | 18.5/28.9/32.2 | 8.0/15.4/26.2 | 39.9 | 17.1/25.7 |

All18 representative scenarios completed20 hot samples and their semantic assertions.
All observed p95/p99 latency, mixed-heap, overall heap/RSS and loop thresholds pass
in this local cohort. Worst hot p95: preflight27.36ms, commit28.91ms, read19.73ms;
heap increment5.9–49.6MiB, maximum process heap125.82MiB/OS RSS343.63MiB;
loop p95/max19.23/47.81ms. No OOM. This does not establish reliable tails from20
samples or replace the unrun1vCPU/4GiB container and parent#91 acceptance lanes.

For the same-input1x/HTTP/readers1 comparison, hot preflight p50/p95/p99 is
4.99/7.20/7.31ms; commit8.83/20.48/34.51ms; read2.68/4.80/6.84ms;
heap increment17,359,776B versus baseline486,462,376B. Response bytes remain exactly
178/1135/7344 (preflight/commit/summary page). After the inherited index migration,
DB after1,350,590,464B and WAL4,255,992B; native hot SQL returned148,196 text bytes.
The baseline native SQL-byte/timing gap is not filled by inference.

The rebuilt-source large HTTP lane also completed20 hot samples: input5,621,522B,
preflight p50/p95/p99=21.8/27.9/29.0ms,
commit=39.2/60.4/69.0ms, read=7.5/13.9/15.7ms,
heap increment52392752B, loop p95/max=37.42/53.87ms.
It passes the unchanged observed local thresholds. The large MCP batch remains413;
no MCP large-batch hot percentile is reported. #95 tracks that capacity gap.

Authoritative files under the private evidence root:
- `delivery-public/results.json` —18 scenarios, cold/hot, SQL/JSON, bytes, DB/WAL.
- `delivery-large-http/results.json` —oversize HTTP working-set and timings.
- `delivery-summary.json` —aggregate observations for review.
- `delivery-build.log` —rebuilt artifact exit0.
- `final-verification.json` and sibling final logs —delivery HEAD and final gate results.

Remaining boundaries: #93 files/OCR/parse/Excel, #95 large MCP delivery, full-database
2x/5x (rather than export rows only), independent read-only heap attribution,
non-snapshot ingestion performance matrices, container1vCPU/4GiB, UI/production/CI
and parent acceptance were not run here. Existing announcement/alias/merge semantics
are regression-tested; that is not a claim about their performance budgets.
The crash test covers interruption inside the business transaction and restart after
success; a kill between business COMMIT and ledger persistence is not simulated.
All full snapshots and generated DBs remain private; no production writes/load.

## Final refresh with #89 cache (supersedes earlier local qualifications)

At the final integration check, `a291fc9901e2f17c56f0244ff6e4247ab69c9ffd`
introduced #89's public summary cache. Merged as `f5ffcbc33539d180887c92e719acac84b077399c`.
Because the changed REST route is the actual mixed-read route, the artifact was
rebuilt and all18 representative cases plus the large HTTP case rerun. Earlier
proof stays bound to its named source; the old final-verification manifest is
preserved as `final-verification-010f845.json`.

| Export scale | Transport | Readers (+1 writer) | Preflight p50/p95/p99 ms | Commit p50/p95/p99 ms | Read p50/p95/p99 ms | Mixed heap delta MiB | Loop p95/max ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1x | HTTP | 1 | 4.9/7.0/8.2 | 8.2/10.5/16.9 | 2.9/4.0/5.5 | 16.7 | 13.5/14.1 |
| 1x | HTTP | 2 | 5.3/7.1/8.8 | 8.8/12.6/18.2 | 3.0/6.4/17.6 | 13.5 | 12.4/13.4 |
| 1x | HTTP | 5 | 7.0/10.1/22.6 | 11.2/19.2/22.9 | 4.5/9.2/21.1 | 13.8 | 17.5/24.2 |
| 1x | MCP | 1 | 6.4/10.3/10.5 | 9.9/12.3/22.1 | 3.3/6.2/9.8 | 42.5 | 15.1/22.4 |
| 1x | MCP | 2 | 6.3/8.1/9.3 | 11.1/17.0/22.7 | 3.2/7.6/11.3 | 48.6 | 16.9/19.1 |
| 1x | MCP | 5 | 7.1/10.2/13.7 | 10.4/16.2/23.1 | 4.0/10.7/16.0 | 37.9 | 14.4/19.0 |
| 2x | HTTP | 1 | 4.8/6.8/7.5 | 8.9/11.8/25.0 | 2.9/4.4/6.2 | 16.6 | 13.9/22.0 |
| 2x | HTTP | 2 | 4.9/7.4/9.6 | 8.8/11.5/23.3 | 3.2/5.8/10.5 | 16.9 | 13.4/27.4 |
| 2x | HTTP | 5 | 4.8/6.2/7.2 | 8.0/9.9/18.1 | 2.8/4.9/7.9 | 18.6 | 12.5/20.0 |
| 2x | MCP | 1 | 4.9/5.8/6.1 | 7.8/15.3/23.0 | 2.4/3.6/7.6 | 46.8 | 12.3/22.9 |
| 2x | MCP | 2 | 5.1/6.4/6.5 | 8.0/15.1/20.9 | 2.4/4.5/9.4 | 48.3 | 13.9/23.1 |
| 2x | MCP | 5 | 5.9/8.2/11.0 | 8.7/14.5/15.2 | 2.9/6.4/7.2 | 37.8 | 13.2/14.7 |
| 5x | HTTP | 1 | 4.0/5.4/5.7 | 6.8/9.1/16.8 | 2.3/3.6/3.9 | 11.2 | 15.9/23.4 |
| 5x | HTTP | 2 | 4.2/5.4/5.6 | 7.0/8.6/12.5 | 2.4/3.8/7.7 | 12.0 | 13.3/14.0 |
| 5x | HTTP | 5 | 4.8/6.4/6.7 | 7.8/10.3/13.0 | 2.8/4.3/8.3 | 13.0 | 12.8/14.7 |
| 5x | MCP | 1 | 4.6/5.4/5.5 | 8.2/13.2/13.3 | 2.2/3.2/5.8 | 46.8 | 13.2/15.3 |
| 5x | MCP | 2 | 5.2/6.2/6.5 | 7.9/13.6/14.5 | 2.4/5.8/9.2 | 48.3 | 13.2/14.5 |
| 5x | MCP | 5 | 5.7/6.4/6.6 | 8.6/14.9/21.4 | 2.8/4.0/7.3 | 44.2 | 14.8/21.8 |

Observed normal scenarios:18; frozen-threshold failures:0.
Hot heap increments11.2–48.6MiB;
maximum process heap127.27MiB, OS RSS343.09MiB.
Worst hot p95: preflight10.34ms,
commit19.20ms, read10.66ms;
loop p95/max17.53/27.39ms. No OOM.
The same1x/HTTP/readers1 case has heap increment17490496B,
preflight=4.9/7.0/8.2ms and commit=8.2/10.5/16.9ms.

Large HTTP (same300-row5,621,522B input,1.2MB singleton,5 readers+1 writer):
preflight=13.8/15.7/15.8ms, commit=24.9/54.4/55.4ms,
read=3.4/4.3/4.8ms, heap increment48987576B,
loop p95/max39.62/50.40ms.
The large MCP batch capacity remains unsupported413 and is tracked by#95;
the complete same-key HTTP recovery remains the explicit policy, not a silent split.

Current authoritative performance files: `delivery-cache-public/results.json`,
`delivery-cache-large-http/results.json`, `delivery-cache-summary.json`,
`delivery-cache-build.log`. The final SHA/gates will again be bound in
`final-verification.json`; prior gate logs and the old manifest are retained.
This run includes the inherited cache; it is not a claim about #94 alone or a
measurement of cache hit rate. The container/production/CI/parent and other
unrun boundaries listed above still apply without relaxation.

## #94 finalization-window recovery follow-up (2026-10-20)

The earlier first-chunk SIGKILL probe did not cover finalization. The additional
`node scripts/verify-snapshot-ingestion-finalization.mjs` verifier uses three
fresh synthetic SQLite databases and the built Nitro HTTP API. A driver hook
pauses **after** each named native statement returns; the parent kills only its
owned server process, then starts a new process on the same database:

| Interruption point | Public readback after restart | Same-key result |
| --- | --- | --- |
| `import_batch` set to `committed`, before receipt finalization | Preflight receipt plus one `processing` attempt; no item audit or source row | Preflight reuses batch ID and plans one add; commit writes 300 source rows plus batch and yields one committed receipt |
| `import_receipt` set to `committed`, before outer transaction COMMIT | Same `processing` history, no item audit or source row | Same complete retry and receipt history |
| Native outer COMMIT returned, before HTTP response | One committed receipt, one item audit and all 300 source rows | Same-key commit replays the durable result across two restarts; no new receipt |

The verifier reads every source row through the public source endpoint, checking
its row number and Unicode/whitespace raw fields; receipt metadata, items and
history are read through authenticated public HTTP. The two pre-COMMIT probes
show that batch, business and receipt terminal writes roll back together. The
post-COMMIT probe covers a lost success response. A retained `processing` attempt
after a pre-COMMIT kill is unresolved history, not evidence of a partial commit.
These are deterministic synthetic fault probes, not storage-power-loss or
production durability measurements. The earlier first-chunk and MCP fallback
verifier remains separate.

The existing `bench-snapshot-ingestion.mjs` is prepared for a controlled private
2x/5x matrix with a fresh output directory and source SHA. That heavy matrix was
not run by this follow-up. Its prior observed cohorts above retain their own
source bindings; container, production and parent acceptance remain separate.
