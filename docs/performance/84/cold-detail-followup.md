# #84 residual 5x detail cold read: pinned investigation

Base source: `fc37375eb35ecd175a5746d93dc22129d2a2ffe3` (2026-10-20). The
outstanding observation in [the integration handoff](../81-89-handoff.md) is one
**default heap / 5x / HTTP detail cold** response at **812.347458ms**, above the
frozen 750ms ID target. The old result is a single cold observation, not a hot
p95, and its original per-statement trace is unavailable here. Earlier R2
matrices used other source SHAs and smaller cold values; neither those results
nor the probe below cancels this miss. No OS cache purge, controlled container,
Linux/Node22 run, production run, or exclusive 5x rerun is claimed.

## Narrow diagnosis

The detail reader does not materialize unrelated raw response columns. Its
`platform_query` key scan uses `platform_query_key_idx` as a covering index on a
disposable 10,000-row SQLite probe, so an unrelated raw-body table-page read is
not established as the cause. The exceptional Unicode/legacy key contract
still requires a normalized key scan. The current detail also requests all
three title assessments in both directions. Each call to the **shared**
`readQueryAssessment` repeats `queryMetadata`'s normalized key scan. This is a
credible scale-dependent SQL cost; it is not proven to account for the original
812.347458ms cold sample.

On an isolated SQLite fixture with one enterprise, zero matching queries, no
raw bodies and 0 / 2,000 / 10,000 unrelated plain query keys, the same native
worker's detail diagnostic reported:

| Unrelated query keys | Connection ms | Projection ms | SQL ms | SQL calls | Encoding ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1.652 | 14.408 | 0.735 | 48 | 0.870 |
| 2,000 | 0.088 | 10.197 | 3.925 | 48 | 0.596 |
| 10,000 | 0.074 | 24.309 | 18.380 | 48 | 0.564 |

The connection remains open after the first request; these are **small,
sequential, warm-cache diagnostic samples**, not a 5x HTTP benchmark. A second
10,000-key direct SQLite probe timed the six shared coverage statements at
14.230ms of a 22.203ms detail read. Its one enterprise-owned query-ID selection
cost 1.726ms. The six statements and 48 total calls stayed constant; per-call
key-index work grew with unrelated keys. The SQL instrumentation observes native
statement execution and row materialization, not physical disk I/O. The first
attempt to run the worker probe hit its existing 5s source-loader startup guard;
it is a retained failed probe, not a read measurement. A later probe produced
the table above, then the standalone script exited with an unsettled shutdown
await after printing all three samples. No pass status is inferred from that
script exit.

## Verification and next boundary

The worker now publishes `connectionMs` and `projectionMs`, plus detail-only
`sqlMs` and `sqlCalls`, on the existing local diagnostics channel beside its
prior `readMs` and `serializeMs`. List cursor timing stays on its prior path.
This changes no HTTP/MCP body, timeout, query semantics, heap
limit, schema, or cache. `reports connection and SQL work separately from
encoding` was red for missing metrics, then passed against the real native
worker. The test starts the worker before the measured detail so source-loader
startup is not misclassified as detail latency. The phase fields are numeric
diagnostics, not continuous profilers or a latency remedy.

With the modified tree built locally, `node scripts/verify-enterprise-read.mjs
/tmp/ningbo-perf-83-90/84-synthetic-current.sqlite --prepare-only` produced an
isolated 125-enterprise fixture, and `node --max-old-space-size=2048 --expose-gc
scripts/bench-enterprise-read.mjs http
/tmp/ningbo-perf-83-90/84-synthetic-current.sqlite detail 1 1` exited 0.
The final compiled HTTP cold response was 42.393ms, with result SHA256
`c34878e87397604b0fdd1c6c5cf5b405108b9e8eb55cae8c08f7ff300e125e71`;
its worker reported connection 1.740ms, projection 25.412ms, SQL 3.115ms over
60 calls, and encoding 3.311ms. The one hot response was 15.924ms; one sample
has no useful tail percentile. Raw aggregate output remains outside Git at
`/tmp/ningbo-perf-83-90/84-current-http-detail-final.json` and records base SHA
`fc37375...` plus a nonzero working-tree diff hash, **not** a committed source
SHA. This small fixture does not test the historical 5x miss.

`pnpm vitest run tests/enterprise-read-async.test.ts
tests/enterprise-read-http.test.ts --maxWorkers=1` passed 18/18; `pnpm
typecheck` and `pnpm build` exited 0 after fixing a test-only indexed-property
type error. The first focused test run timed out during source-loader startup;
the next run reached the expected missing-metrics assertion, then a later green
run passed. The existing `node scripts/verify-enterprise-read.mjs` exits 1 on
this repository head because it compares current #108 additive detail fields
to the `d198a09` whole-object shape. That historical verifier needs a separate
additive-contract update; its failure is not reported as a new business
regression or a passing equivalence gate here.

## Fixed-ID coverage follow-up

The parent assigned #84 the narrow shared evaluation helper after the probe.
The enterprise snapshot already selects its owned query IDs once, including
exact name keys, normalized USCC keys, and relations matched to the enterprise.
Detail coverage now selects the newest 51 rows from that ID set instead of
repeating the global normalized-key predicate. A request-local map evaluates
coverage once per title and passes the same value to both directions; decision
and evidence impact remain direction-specific. There is no cross-request cache,
new schema, or changed response field. Evidence-only queries from difference
history do not become owned coverage. The existing 50-source/truncated rule and
metadata parsing still run in `query-assessment.ts`.

The new test was red with **8 coverage SQL statements** for one detail; it is
green at **3** after the change. At 200 and 1,000 unrelated exceptional Unicode
keys, detail output stayed identical. The test bounds normalizer growth to one
additional visit per added unrelated key plus a small constant, rather than a
visit per title/direction. Its fixture also checks recognized partial
`exact_uscc` and failed `name_only` sources; the #109 HTTP suite checks
`complete`, `no_record`, `partial`, `failed`, source/subject identity,
truncation, direction-specific decisions, and MCP readback. Focused suites:
`enterprise-read-http`, `enterprise-read-async`, `query-coverage-109-http`,
`platform-recognized-evidence`, and `roster-api` passed **74/74**; `pnpm
typecheck` and `pnpm build` exited 0.

On the same small synthetic SQLite fixture, the compiled HTTP detail result
SHA256 stayed `c34878e87397604b0fdd1c6c5cf5b405108b9e8eb55cae8c08f7ff300e125e71`
before and after the fix. Detail worker SQL calls fell from 60 to 50. The
post-fix single HTTP and MCP cold responses were 33.522ms and 35.223ms,
respectively; both returned that same canonical result hash. These are small
fresh-process, warm-OS-cache samples, not 5x SLO evidence. The raw outputs are
outside Git at `/tmp/ningbo-perf-83-90/84-fixed-{http,mcp}-detail.json`.

One normalized pass over exceptional legacy keys still remains in the
enterprise snapshot. Eliminating that scan requires the persisted-key/schema
design recorded in [the #87 request](index-request.md). The historical
**812.347458ms** default-heap 5x HTTP cold failure remains open; the original
per-statement trace is unavailable. An exclusive same-input 5x run should
record worker phases, HTTP cold time, result hash, process memory, and
host/container state before any SLO conclusion.
