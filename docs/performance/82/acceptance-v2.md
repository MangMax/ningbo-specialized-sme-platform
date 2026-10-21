# #81–#95 performance acceptance v2

Version 2, 2026-10-21. User authorization: “请以实际情况为准调整验收条件，不要死磕了”. This is an explicit prospective acceptance-policy change, not a corrected measurement or a claim that frozen v1 passed. The complete [v1 budgets](budgets.md), original issue bodies/checklists and every failure, individual sample, setup error and disk-reserve breach remain evidence. No runtime limit changes accompany this document.

The current application source is `b76c04cb95d6a6acf11a4fb4ba31ff61e639a699`. The source-bound [combined report](combined-runtime-b76.md) and [individual samples/aggregate](combined-runtime-b76.json) are authoritative for the fresh Linux lanes. Earlier [96a results](final-96a-node-matrix.md), [9928 continuation](canonical-continuation-9928.md), [phase diagnosis](phase-diagnosis-3a13d84.md), [main-sync verification](main-sync-20261021.md) and [PG study](../90/final-96a-results.md) retain their own source and scope. See [per-issue disposition](per-issue-disposition.md); nothing here closes tickets or establishes #91/CI/production acceptance.

## Hard invariants

Correctness remains mandatory: exact selected raw text and provenance, complete required rows/relationships, distinct unknown/failed/absent states, role separation and error envelopes, atomicity, durable receipts, idempotency/replay, cache consistency and recovery after committed-but-lost replies. No truncation, invented business facts or silent omission is allowed to meet a performance number. Ordinary UI revision guards, retry semantics and desktop plus 390px functional verification remain required.

No OOM; heap below 1.8GiB and RSS below 3GiB; main old-space 2048MiB with explicitly bounded child processes/admission. Report per-process and conservative combined measurements, envelope and sampling limitations. Do not claim a hard peak from a sampler that can miss synchronous peaks. Fixed-scope work must not grow heap linearly with unrelated archives. Payload-proportional costs must be distinguished from unrelated-data growth. Page/chunk/concurrency bounds, streaming/backpressure and cancellation/recovery contracts remain in force.

These are acceptance conditions, not a declaration that every unmeasured lane satisfies them. Preserve the 12GiB forecast headroom/8GiB hard disk rules and ownership-scoped cleanup; an active guard does not prove a later idle reserve invariant. A rejected allocation is **RESOURCE-UNVERIFIED**, neither a performance failure nor a pass. Historical reserve breaches remain failures of the resource-control condition.

## Classify the response before applying a budget

| Class | Applicable rule |
| --- | --- |
| Ordinary summary/metadata list, page ≤50 | 256KiB frame target and p95 ≤500ms; unrelated-archive heap growth remains prohibited. |
| Metadata ID lookup | p95 ≤750ms; original scoped-memory expectations remain. |
| Scoped comparison with ≤100 actual participating records | p95 ≤2s; freeze the actual join/union scope before requests, not just page size. |
| RAW: contractual legacy DEFAULT FULL, or explicitly requested retained raw/provenance/full archive detail | Preserve the complete chosen rows/body and original full/default behavior. The metadata-list 256KiB frame gate is **CONTRACT-EXCLUDED**, not passed. Retain bounded pagination/chunks/streaming and hard resource invariants; disclose response bytes and payload-related memory costs. |

RAW is determined by actual response content and the consumer's contract, not by endpoint name or slowness. It cannot exempt an ordinary metadata projection. An ordinary page accidentally fetching a 13,271,319B enterprise DEFAULT FULL response remains a product risk and possible projection follow-up; RAW classification alone proves neither UI performance nor absence of interaction stalls.

Observed #83 DEFAULT FULL frames (HTTP 605,672B / MCP 631,276B) and #85 frames (HTTP 1,878,341B / MCP 2,014,342B) are baselines, not new caps. The original `2 × body + 64MiB` model remains a capacity-planning reference, not a universal hard allocation bound across UTF-16 strings, parsed objects and duplicated MCP envelopes. Do not substitute an arbitrary larger cap or remove resource bounds.

The v1 p99 figures remain recorded reference targets. Twenty hot samples describe those runs; their p99 is not a statistically reliable hard population-tail acceptance gate. Keep cold/hot, transport, concurrency and all individual samples separate. Ordinary p95 targets above remain meaningful engineering targets rather than post hoc thresholds chosen above observations.

## Event-loop and processing decisions

100ms event-loop p95 remains the ordinary-interaction design target. Near-threshold 101–126ms raw point observations and 200–300ms complete-raw observations are retained **RISK**, not “fixed”, and do not alone force a new architecture or block delivery. Large processing/raw paths prioritize exact results, bounded work, no OOM and measured ordinary-reader latency, with no observed ordinary-request blocking over 500ms. An event-loop sample is not an ordinary HTTP probe; where such a probe was not run its result is **UNVERIFIED**.

#94's current 21 scenarios retain the original stricter gates; all observed checked gates passed in the combined report. Their scope is representative export-growth 1/2/5 plus large HTTP, not every business domain at 5x. Historical misses and diagnostics remain unchanged. Do not attribute the improvement to one import-isolation change: main and Node version also changed.

App descendants and driver shared a 1CPU cgroup in the current study. Process CPU includes other V8 threads; instrumentation and body validation have costs. These diagnostics do not establish an intrinsic app-main-thread SQL cause. Strong causal/SLO claims require an identified app quota, disclosed observer costs and appropriate thread/probe evidence. No additional measurement is authorized by this policy. Further performance work requires reproducible user impact, a clear hypothesis/root cause and a bounded timebox.

## Scale, inheritance and PostgreSQL decision

Growth proof is workload-specific. State exactly which domains/rows/raw bytes grow, prove keys/FK/integrity and selection before requests, and distinguish synthetic data from the real copy. Export-only 5x or query/relation 2x is not whole-application 5x. Resource-rejected or unsupported scales stay **RESOURCE-UNVERIFIED**; full capacity, mixed workloads, CI, production and #91 remain open.

Exact module/schema equivalence can justify explicitly inherited correctness evidence. It never converts old measurements into fresh final-SHA performance evidence. Current 390px and revision-mismatch lanes remain required and unrun; older browser proof must retain its original source identity.

#90 is a decision spike: a defensible ADR, explicit compatibility/operational costs, scoped restore proof and a defer/reject/migrate recommendation satisfy its investigation purpose. It does not require a full application PG port, a production migration or a fresh-main whole-business 5x run. The historical four-table 1x and query/relation 2x study supports the [defer ADR](../90/adr.md), with its engine/runtime/resource differences, restore scope and retained misses. Production adoption would require separately authorized compatibility, full-data recovery and operational acceptance.

## Evidence status and authority

Use **OBSERVED-MET** only for the measured source, seam and input; **INHERITED** for identified prior evidence; **CONTRACT-EXCLUDED** only for an inapplicable metadata gate; **RISK** for retained excursions/interaction concerns; **RESOURCE-UNVERIFIED** for rejected/unrun resource lanes; and **OPEN** for required remaining acceptance. Real correctness bugs remain bugs. No rewritten historical aggregate may turn an old miss into a pass.

Original requirements/state were retained in the private snapshot `/tmp/ningbo-perf-83-90/acceptance-v2/issues-before.json` and source-run `issues/*.json`, with public issue links in the disposition. These versioned docs change acceptance interpretation only. Issue state/checklists, final review, PR readiness and parent acceptance require their own explicit decisions.
