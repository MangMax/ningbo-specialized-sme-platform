# #85 correspondence read performance

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


## Scope and invariants

Only correspondence list, point, reverse-source, candidate and audit reads change. No schema or migration changes; #87 retains that ownership. No production requests or writes, PRs, main merges or issue closure. All measurements use isolated synthetic databases or a private clone of the frozen #82 full snapshot. The shared snapshot is never opened writable.

List predicates (including role/ruleVersion), ascending ID order, total and pagination execute in SQLite. Point reads use the primary key; audit existence/count/page do not load or revalidate every correspondence or deserialize earlier audit evidence. Public pages omit private target identity and candidate provenance from materialization; full persisted provenance remains available to audit and unchanged core reads. Confirmed rows still load the exact complete sources required by the existing fingerprint algorithm.

Public reads share one SQLite read transaction. Hydration batches the selected events, original evidence/files, relations/queries, exports and reverse references. Candidate queries explicitly select only named query/export batches, omit unused raw response/row payloads, batch prior decisions and retain JS USCC normalization. Relation sequence and export source-row order survive out-of-order archive insertion. Partial/zero/failed coverage, every typed edge/role/status/revision and proof revalidation remain distinct; candidate generation is read-only and never promotes a candidate.

There is no persistent/shared cache. Request-local maps expire with the synchronous read transaction. Writes, idempotency, proof qualification, append-only audit and stored fingerprint formats remain unchanged.

## Frozen budgets and reproducibility

Targets are the unchanged `/tmp/ningbo-perf-81-89/baseline.md`: 2048MiB Node old-space, lists <=50 p95 500ms / p99 1s / response 256KiB / incremental heap 64MiB; point p95 750ms / p99 1.5s / heap 64MiB; scoped candidates <=100 p95 2s / p99 4s / heap 128MiB; heap <1.8GiB, RSS <3GiB, event-loop p95 <100ms / max <500ms. This local Apple M4 / Node24.22.0 host is shared and is **not** the controlled 1-vCPU/4GiB deployment envelope.

Two checked-in harnesses separate driver diagnostics from compiled Nitro transport:

```sh
node --max-old-space-size=2048 scripts/bench-correspondence-reads.mjs prepare /absolute/scratch.db 1
node --expose-gc --max-old-space-size=2048 scripts/bench-correspondence-reads.mjs read /absolute/scratch.db 1 /absolute/source-root 1 20
node scripts/bench-correspondence-http.mjs /absolute/scratch.db http list 1 20
```

Synthetic 1x/2x/5x have 400/800/2000 distinct event/query/relation/correspondence rows and 500/1000/2500 audit rows. Each query includes about 40KiB archived body plus duplicated collection row payload; correspondence/audit provenance is about 36KiB. This deliberately amplifies unused fields; it is not represented as the full production distribution. Fixed request inputs include page1/25, page300/1, ID1, event1, audit page400/1 and candidates event1/query1. Every fixture has the same selected original source values; total naturally changes with growth.

Diagnostic SQL bytes mean materialized driver values, not disk I/O. SQL timings include native materialization; JSON/aggregation/serialization/loopback transfer remain in total residual and are not claimed as separately instrumented. Heap/RSS sampling occurs after driver reads and responses; transient allocations between samples may be missed. Compiled telemetry samples endpoints and a 5ms timer. Cold means a fresh compiled server process, OS cache not purged; the diagnostic harness has one fresh process per matrix cell, so only its first lane is process-cold. Hot cells have 20 samples; p95/p99 are observational order statistics, not reliable production-tail estimates.

## Evidence locations and exact source

Private evidence directory: `/tmp/ningbo-perf-81-89/85/`. The implementation commits, integration merge and final verification SHA are recorded in the handoff. Baseline source is `d198a09f5a6fab2d5358d442d1b6ce47670c7506`; optimized runtime source is `e28613c33dc984e4dbffe95a87511dbdce359be0` plus any explicitly documented final integration merge. No raw responses, credentials, source documents or database files are committed.

The full snapshot clone is `/tmp/ningbo-perf-81-89/85/full-private-copy.db`; clone and shared snapshot SHA256 were equal before use. The clone is opened read-only for measurements, has `integrity_check=ok`, zero FK violations and zero existing correspondences. It supports real-distribution event/relation/candidate reads and empty correspondence lists; populated correspondence/long-audit scenarios therefore use synthetic fixtures.

## Regression evidence

All generated tests are in `tests/record-correspondence-bounded.test.ts`, using real SQLite and loopback HTTP plus the public MCP application dispatcher. Compiled transport is a separate harness lane.

| Requirement | Evidence |
| --- | --- |
| Deep page and point avoid unrelated provenance | `keeps deep list and point results independent of unrelated correspondence provenance` (old driver212398917B; selected unused provenance regression600988B; public page budget128KiB) |
| Audit pages earlier history without decoding it | `pages long append audit without materializing earlier evidence or revalidating source bodies` (160 large audit rows, page80, literal revisions79->80) |
| Explicit-source, normalized identity, ambiguity, read-only candidates | `keeps selected-source candidate ambiguity and normalized identity while excluding archived payloads` (old driver51322786B; budget256KiB; excludes an unselected matching source) |
| Multi-event/source hydration | `hydrates many events and relations in batches while retaining each original source and reverse link` (old244 queries for40 rows; budget<30) |
| Confirmed fingerprints and immutable historical evidence | `batch revalidates confirmations without changing fingerprints and detects fresh source drift` (old469 queries for20 rows; budget<50; original audit page remains1 after current source page99) |
| Independent-connection commits and coherent public reads | `reads atomic pages and append audit during public commits on a separate SQLite connection` (25 public commits, barrier-controlled intermediate state,30 HTTP reads, public append audit) |
| All six types, all12 roles, four statuses, revision/filter/error parity | `preserves all typed roles, four statuses, conjunctive filters and public errors on REST and MCP` (candidate preview preserves existing IDs/revisions without promotion) |
| Original order despite archive insertion order | `keeps original relation sequence and export source-row order when archive insertion order differs` |

Existing `record-correspondence-api.test.ts` and `record-correspondence-core.test.ts` retain malformed JSON, no-store, secret echo redaction, proof-backed equivalence, stale plans, atomic rollback and same-edge reconfirmation coverage.

## Index ownership and limits

`query-plans.jsonl` records PK point access, ordered audit index and query/sequence index use. Event-or-predecessor reverse filtering still needs #87 to evaluate a predecessor index: this ticket restricts returned/materialized rows but does not claim every SQL plan avoids a scan. Filters/counts may scan lightweight columns. No index is added here.

Unpaginated reverse references and explicitly selected original bodies retain the existing contract. The regression fixture with a roughly576KiB single audit evidence body intentionally verifies equivalence/bounded paging; its response exceeds the256KiB list response target and is not a response-budget pass. Fanout or single relevant body sizes can exceed interactive response/heap budgets; there is no silent truncation or new cap. Candidate work is bounded to explicitly selected source IDs, whose lightweight row count still determines computation. Large relevant fanout, full-scale 2x/5x distribution, deployment CPU/container equivalence and UI acceptance are separate from the measured synthetic unrelated-growth result.

## Measurements and validation

Final result summary is recorded below after exact-source measurement and integration sync. An earlier intermediate implementation exceeded the64MiB list delta at5x/c5 (~66MiB); it was corrected by excluding unused private candidate provenance. That superseded sample is retained and is not marked passed. Any observed cold/lag budget miss remains reported rather than hidden by a later warm run.

### Frozen-input before/after

Diagnostic loopback HTTP, c1, identical SQLite input and canonical public JSON hashes. 1x has20 hot samples; 5x baseline has2 (observations only, no reliable tails). Optimized rows are runtime `e28613c`. Other host work was present; these are local observations, not controlled-container acceptance.

| Lane | Baseline1x p95 ms | After1x p95 ms | Baseline1x driver B/request | After driver B/request |
| --- | ---: | ---: | ---: | ---: |
| list | 3693.30 | 7.33 | 757,504,890 | 14,847 |
| deep | 322.82 | 3.61 | 44,520,381 | 604 |
| point | 350.29 | 3.48 | 44,520,386 | 37,485 |
| event | 378.69 | 5.63 | 59,333,177 | 37,485 |
| audit | 272.70 | 4.13 | 33,322,082 | 37,035 |
| candidates | 249.85 | 4.19 | 14,895,104 | 457 |

At5x, baseline page25 materialized3,779,367,141B/request and observed p95 24,615ms (n=2); optimized materialization stays14,847B and c1 p95 is12.30ms. Deep page stays604B, point/event37,485B, audit37,035B and candidates457B at1x/2x/5x. Exact same-input canonical response hashes match for all six baseline/after lanes at1x and5x.

### Matrix observations

| Lane | Cells | Max cold ms | Max hot p95 / p99 ms | Max heap delta MiB | Max sampled RSS MiB | Max response B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Driver diagnostics,1x/2x/5x × c1/2/5 ×6 endpoints | 54 | 594.43 | 171.57 / 172.59 | 56.25 | 277.19 | 47,852 |
| Compiled Nitro,1x/2x/5x × REST/MCP × c1/2/5 ×7 endpoints | 126 | 6449.30 | 350.57 / 413.06 | 36.74 | 278.17 | 87,159 |
| Private full distribution,REST/MCP × c1/2/5 ×4 endpoints | 24 | 165.55 | 73.14 / 73.85 | 39.38 | 268.89 | 11,232 |

All completed compiled cells returned200 and asserted exact REST/MCP semantic equality; no observed OOM. Synthetic hot latency/response/heap and hard process-memory observations meet their numerical budgets. The full1x private-copy cells also meet measured cold/hot/heap/response/event-loop budgets. This does **not** establish all frozen SLOs:

- Diagnostic1x/c1 cold list took594ms with event-loop max582ms; its hot p95 was7.33ms. Retained as a cold/lag miss.
- Compiled synthetic event-loop p95 exceeded100ms in26/126 cells (max329.25ms); max lag remained329.25ms (<500ms).
- Three compiled synthetic cold list/deep requests exceeded500ms:2x REST list c1=2138.43ms,5x REST list c1=538.35ms,5x MCP deep c5=6449.30ms. No specific cause has been established. Hot p95/p99 stayed within their frozen budgets.
- Full snapshot has0 correspondences, so populated point/audit and growth results are synthetic; full-distribution2x/5x, controlled1-vCPU/4GiB deployment, browser desktop/390px and production lanes are unrun.

Private `results-summary.json` records every observed miss and its source file. Earlier superseded runs remain available; no failed lane is relabeled by a later successful warm run. SQL plans retain the predecessor-OR scan for #87 evaluation.

### Validation provenance

Runtime code is `e28613c`; the final documentation/test-only commit retains that same runtime tree. `build-e28613c.log`, `typecheck-e28613c.log` and `prod-openapi-e28613c.log` finished with exit0; the OpenAPI check used the compiled artifact and a read-only isolated DB. Correspondence target suite:49/49 passed (`targeted-errors.log`), including expanded source/candidate404/400/no-store parity.

A full earlier run finished2080 passed /11 skipped before the final projection change. A later exact-runtime full run at higher worker concurrency failed3 tests plus1 suite (startup/5000ms/deadline timing); all four affected files then passed57/57 unchanged at one worker (`recheck-failures-e28613c.log`). These attempts remain preserved. The final-head full run is written to `test-final.log`; its actual outcome and final SHA belong to the handoff and must be checked directly, not inferred from this document.

No browser/production/parent acceptance is claimed. No credentials, raw business content, databases, uploaded sources or intermediate research/plan/status files are staged.
