# Source catalog and record comparison performance (#86)

Implementation commits: `d6b9ef9` (scoped reads), `9cf1635` (cooperative snapshot
reads), `86a6e71` (deep catalog ID pagination). The measured code head is
`c57048932fa2fec4c227bc511baef0ffc331d6d1`. Integration #82/#83/#84/#85/#87/#89
was merged into this branch; #86 introduces no schema/migration of its own.

## Closeout acceptance gap

The final repeat at `d5da316a0a450aa8b84b7db7d8429c148c9fd2b0` completed all
36 configurations. One 5x catalog cold request took 603.1 ms with a 604.5 ms
cold event-loop maximum, exceeding the frozen 500 ms boundary. The other
35 configurations met the checked gates; all hot latency/heap/loop gates passed.
The worst hot p95/p99 was 330.6/332.1 ms, hot loop p95/max 92.6/151.4 ms,
and concurrent process heap delta 114,111,432 bytes. The cause of this cold
outlier has not been isolated. This is an unresolved acceptance gap, not a
passed cold lane. The earlier 36-case measurements below remain historical
observations at their stated code head; they do not replace this failed sample.

Full suite at that closeout head: 145 passed files / 2 skipped; 2,106 passed
tests / 11 skipped. Typecheck and the production build/OpenAPI isolation verifier
passed. The reporting follow-up changes this document only. Raw closeout files
are `closeout-public-*.json`, `closeout-gates.json` and the corresponding head
and artifact SHA-256 records in the private evidence directory.

## Frozen baseline and result equivalence

Targets remain [SLO v1](performance/82/budgets.md), frozen at
`d198a09f5a6fab2d5358d442d1b6ce47670c7506`. Measurements use private consistent
SQLite copies. The shared full snapshot was never opened for writing; its final
SHA-256 still equals the unmodified 1x copy. Original documents, credentials,
DB files and payloads remain outside Git.

The exact #82 source input is an unfiltered catalog page of 50. The comparison
selects the archived query with the largest original response, the first formal
document and enterprise, no exports, page size 50. Selectors remain private.
Both complete response bodies match the frozen baseline hashes:

- Catalog: 16,580 bytes; `158ad215f957790ac02610a8c79b9851cc224632d77ceeebd532843a560cb81b`.
- Comparison: 7,006 bytes; `3ca32766c3fda93f6b5a3153e88aca010cec9fe032dd38041fe27d13c1927714`.

| Same input | Frozen cold HTTP diagnostic | Current direct service cold | Frozen SQL bytes | Current behavior |
| --- | ---: | ---: | ---: | --- |
| Catalog page 50 | 2,006.7 ms | 35.8 ms | 919,171,763 | count + light ID window and page metadata |
| Explicit comparison | 7,996.7 ms | 116.7 ms | 1,248,417,738 | selected archive rows + light streamed formal facts |

The frozen heap peaks were 1,901,235,224 and 1,913,045,840 bytes respectively.
The current fixed comparison direct-service incremental heap was at most
60,434,920 bytes in this replay. Current SQL return bytes were 2,899,003 for that
comparison. The direct service and frozen h3 HTTP diagnostics are different
measurement seams: this table is not a compiled-Nitro speedup ratio. Compiled
HTTP/MCP results are measured separately below.

The old directory pagination still walked archive-bearing table pages for a
deep OFFSET. A cold page-1000 request took about 2 seconds despite returning only
25 metadata rows. Selecting IDs through the existing covering key index and
then seeking metadata reduced direct cold observations to 44.5/418.2 ms at
1x/5x; the complete response hashes stayed unchanged. Explicit ID hydration uses
primary-key seeks. No evidence field is truncated or deleted from storage.

## Current public HTTP/MCP matrix

Actual compiled Nitro, Node 24.22.0, `--max-old-space-size=2048`, one app process,
Apple M4 / 24 GiB; no cgroup or 1-vCPU deployment equivalence is claimed. Each
configuration has one fresh-process cold request and 20 hot requests, concurrency
1/2/5. OS caches are not purged. Percentiles are observed nearest-rank values;
these sample sizes do not establish reliable tails.

The 1x private snapshot has 39,303 queries / 58,310 relations. The 2x/5x copies
have 78,606/196,515 queries and 116,620/291,550 relations. Growth is synthetic
unrelated archive payloads (about 33 KB response / 5.4 KB relation fields), not a
claim that every business table was replicated. Formal events and enterprises
retain the full original 1x distribution. The selected comparison body hash is
identical at every scale and transport.

36 configurations cover the source catalog, deep page 1000, REST comparison and
MCP `list_record_comparison` at all three scales and concurrency levels. No
source-catalog MCP tool exists; that combination is not claimed.

| Surface | Configurations | Worst cold ms | Worst hot p95 / p99 ms | Max incremental heap | Max RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Catalog page 50 | 9 | 428.9 | 18.5 / 22.1 | 10,794,112 B | 277,676,032 B |
| Catalog deep page 1000, size 25 | 9 | 25.9 | 52.6 / 53.8 | 7,719,784 B | 277,135,360 B |
| Explicit comparison, REST/MCP | 18 | 85.5 | 253.1 / 253.5 | 111,586,584 B | 420,642,816 B |

All 36 configurations met the unchanged observed latency, bytes, heap/RSS and
loop gates. The worst hot event-loop p95/max was 86.9/99.2 ms for comparison;
worst cold loop max across the matrix was 430.2 ms. A prior synchronous comparison
had a 784 ms loop stall at concurrency 5. HTTP/MCP now hold an independent readonly
SQLite snapshot and yield between setup and groups of 128 formal events. The
whole concurrent process delta above is separate from the single-request 64 MiB
fixed-scope direct-service check. Framework and wire overhead are included in
public measurements. SQL driver materialization, direct serialization and total
service time are recorded separately; JSON/aggregation residual is not invented
as an independently measured phase.

## Regression and UI evidence

- `catalog pages preserve scope metadata without materializing archive bodies`
  covers mixed-kind pages, ID ordering and source status/range metadata.
- `hydrates a bookmarked source by its explicit ID without walking unrelated catalog pages`
  covers the scoped label lookup and existing retry/selection behavior.
- `comparison preserves all selected relations and formal event uncertainty as unrelated archives grow`
  and `rejects a post-cutoff query before decoding its selected archive body`
  cover selected-row completeness and time filtering before body decoding.
- `stored current proof revalidation reads its original sources without unrelated raw bodies`
  and `comparison ignores out-of-scope candidate proof bodies before source revalidation`
  cover source-bound proof reads. Existing real HTTP/MCP tests retain qualification,
  revocation/drift, offset instants, UTC-day rules and post-cutoff revision behavior.
- `yields to concurrent work while keeping counts and rows in one readonly SQLite snapshot`
  proves a later concurrent commit is excluded from the in-flight response and
  visible to the next read. Removing the transaction makes this test fail.
- `verify-record-comparison-equivalence.mjs` passed 30 readonly checks against the
  frozen implementation, including stored proof fingerprints and paginated reads.

Desktop and 390px were operated in a real browser on the synthetic API-seeded
fixture: source checkboxes, compare, provenance URL, actual PDF page 3/3 and return
selection. Initial T3 click timeouts triggered the documented browser fallback;
a dev optimizer 504 was reproduced and the page was verified using the compiled
artifact. Neither failed attempt is a passed browser lane.

## Reproduction and evidence boundaries

`/tmp/ningbo-perf-81-89/86/` contains private selectors, raw aggregate measurement
JSON, baseline/red/green logs, compiler/OpenAPI logs and synthetic browser
snapshots. The final handoff report identifies the final branch SHA and newest
validation files. `acceptance-*.json` is the 36-case matrix above; intermediate
`public-*` / `final-public-*` files are diagnostic iterations, not final acceptance.

Use `bench-record-comparison.mjs` for direct SQL/heap observations and
`bench-record-comparison-http.mjs` after building the artifact for public reads.
`PERF_QUERY_ID`, `PERF_PAGE_SIZE=50`, `PERF_CATALOG_KIND=all` reproduce frozen
inputs on an isolated copy. An optional last argument selects a deep catalog page.
The scripts open read-only DBs and reject the shared `full-snapshot` path.

Unrun lanes: controlled 1-vCPU/4-GiB deployment, full 2x/5x formal/event/enterprise
corpus growth, large populated proof/correspondence performance, production and
parent #91 acceptance. Large selected scopes are not truncated; the cancellable
job contract in [the read contract](record-comparison-contract.md) is a proposed
follow-up, not an implemented API. This ticket does not close those lanes or any
issue automatically.
