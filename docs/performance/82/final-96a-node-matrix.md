# Frozen 96a Node candidate: controlled child-performance evidence

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


**Performance acceptance remains open.** The serial run observed 30 hot-stage gate-miss rows and 4 cold resource-miss rows. The required host reserve **FAILED**: the 8.5 GiB guard stopped a container, but free space subsequently fell below 8 GiB. All timing stopped permanently; the exclusive Node window was released at **2026-10-20 10:09:43Z** after owned containers stopped and cleanup evidence was saved. The cause of additional host allocation is unknown.


Later authorized continuation: [phase diagnosis and capacity-blocked handoff](phase-diagnosis-3a13d84.md). Its corrected phase observations and seven readiness retries are separate evidence; the historical samples, misses and disk failure below are unchanged.

## Exact source, artifact and environment

- Source archive: `c9f149f14de21e0cc30c9ca95061f4be5c8d98b5` (PG-results docs integration). Application, schema, original harness and all other non-doc tracked files equal `96a0bd9c21d6c0ac32f0de45daf44b76bbda99e6`; no app/schema/contract changes here. The archive contains all **1277** tracked entries with no missing/extra entries. All tracked regular-file hashes matched inside the built image before private harness overlays.
- Archive SHA-256: `bcbadacfa65b86e3891d5e25ce7f14d0081ad71b0b40161e4580a87f9c69472f`. Source tree: `a8aa853ced69268284c4b42c98159bf54a7f2f2b`.
- Image: `ningbo-node-final:c9f149f`, ID `sha256:19cebba9ba04f4b12b04fa01bacd6217bad064620c8a182ae52c9e5b7c7af65e`. Server index SHA-256: `f29554b6f6ed8e7a3acea05e2cac9b395cfc59ddd4582395f4c9dd7c06223525`. Compiled regular-file manifest SHA-256: `b5741dc2532b6ad30b51b2caedcfa9e65fe5ce6fad83641972fab03bbd5bdbbd`. The manifest does not resolve symlinks; the complete image identity covers native dependencies and link targets. The final optional native-file identity helper was **not run** after the resource stop.
- Base: `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`. Actual Linux arm64 Node **22.23.3**, better-sqlite3 SQLite **3.53.4**. One archive-faithful instrumentation build used pnpm **12.11.2**, frozen lockfile, python3/make/g++/git; no host node_modules. `ADD source.tar /app` preserved the repository Dockerfile and all scripts/tests despite `.dockerignore` exclusions. Custom build Dockerfile SHA-256 `ce273003b200bab49b0daa80c04b79086fc161704b060dd66247fdcdc2f15266`; original Dockerfile SHA-256 `de0951ce437cd2789b5e079b8db79035fc130d99b84a520c78febaa8f5cdcd1c`.
- Every measured container: 1 CPU (`cpu.max=100000 100000`), memory **4294967296 B**, memory-swap **4294967296 B** (no swap), pids 256, network none, no exposed ports. Driver and main app old-space **2048 MiB**. The existing enterprise subprocess retains its own 256 MiB old-space policy; its memory is included. One main app plus that implementation child, not multiple app replicas.
- Cgroup includes app, enterprise child, driver, fixture checks and file cache. App/child native RSS and sampled heap are separately grouped by PID/parent; driver cost is separate. Observed conservative app+child native RSS max **417.96 MiB**, sampled combined heap max **139.77 MiB**; driver max RSS **234.68 MiB**, heap **103.32 MiB**. These sampled bounds do not invent unobserved sub-sample peaks. Original request diagnostics/OS peak RSS remain in raw logs. No Docker `OOMKilled=true` observed across **276** containers. Exit137 below is a guard-induced resource stop.
- Cold means a fresh Node/app process; OS caches were not purged. 20 hot samples are descriptive and do not establish reliable p99/capacity. #84/#89 use100 hot samples. Historical Node24 macOS measurements cannot establish a speedup against this Node22 Linux candidate. Shared-host interference was not controlled globally: initial fairness containers and a final external `spztx-outlier-owned-frozen-805a0be5-recognitions-20-c5` were observed and preserved, with no causal attribution.

## Input qualification and immutable boundaries

Original frozen source: `/tmp/ningbo-perf-83-current/real-copy.sqlite`, **1405333504 B**, mode **0400**, freshly reverified after stop using uncached sequential reads: `2c72355ebe602b24d9c0a08561957481d97b083a78aae51995e29e58e4064430`. It was never opened writable. Only a new owned seed was sanitized (`DELETE service_credential`, without selecting credential values), qualified and used for expansion. No source documents, business DBs or credentials are committed.

| Qualified whole workload | Enterprises | Queries | Relations | Query raw bytes | Relation raw bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x | 7,297 | 39,303 | 58,310 | 902,336,692 | 265,951,153 |
| 2x | 14,594 | 78,606 | 116,620 | 1,804,673,384 | 531,902,306 |

Physical2x was made **before0025**, using a private minimal generator fix that suffixes only cloned `edge_key` with deterministic replica coordinates. All42 original-table prefixes matched, all eligible table counts and raw-byte totals doubled, FK violations0 and integrity `ok`. Node applied all final migrations; migration0025 SHA-256 `b12317fa3d39a2891893efccbeffa6a6c1a84c28083ddfbb1136a5e16f0256b0`. Fixed original enterprise/query/document rows matched across scales. Replication does not remap embedded JSON IDs: it proves workload distribution, not whole-business semantic equivalence. Physical5x was reserve-skipped; no5x whole-workload claim.

#86 input was frozen before its timing: query2632, enterprise157, doc1, no export batch, page50. Actual selected relations4, relevant formal event1, correspondence/audit0, export0, **selected-document event evidence0** at both scales. Global formal scalar counts are11932/23864 and are separate from the small row scope. This is **FORMAL-SIDE-EMPTY**, not positive formal-history performance. A deterministic metadata-only lowest compatible official-document/nonempty-event-evidence search found none. First-default metadata (query1:0 relations, doc1:0 evidence) is also retained. No pageSize-as-input-size inference. Legacy-impact performance was not run.

#85 new synthetic fixtures retain120 selected edges with unrelated120/240/600 rows at scales1/2/5. Point/audit/candidate selectors remain1; actual audit rows1, query relations1, event evidence1, event correspondences2. Audit page1 is nonempty; old page400 is not load proof. Full default and explicit summary semantic bodies plus full decompressed frame byte counts are retained privately. Counts/status/revision/evidence and HTTP/MCP parity assertions stayed active.

## Completed, partial and unrun lanes

| Lane | Actual coverage | Boundary |
| --- | --- | --- |
| #83 real copy | Whole1x/2x summary, title, status and page100; HTTP/MCP c1/2/5; n20 | No physical5x. |
| #83 synthetic | Generator1x/2x; fixed key/chunk1000 HTTP/MCP c1/2/5; 2x full list all6 cells | 1x full all6 + key HTTPc1 remain setup-failed/unretried. No supported synthetic5x. |
| #84 | Whole1x/2x list/deep/search/detail, HTTP/MCP c1/2/5; n100; first enterprise ID fixed | No5x whole-copy evidence. |
| #85 | Synthetic1/2/5 default/summary, point/event/relation/audit/candidates; HTTP/MCP c1/2/5; n20; c1 full evidence verifier | Default/full and summary budgets assessed separately. |
| #86 | Whole1x/2x HTTP catalog pages1/100 and scoped comparison HTTP/MCP c1/2/5; n20 | No equivalent catalog MCP tool; formal-source positive and legacy-impact not covered. |
| #89 | Whole1x/2x HTTP/MCP cache off/on c1/2/5; n100; each scale8000-request churn + TTL/retention | MCP bypasses REST cache. No5x, all-write mixed long-run proof or causal historical speedup. |
| #94 | r3 export-growth1: six writer-transport/read-count cases complete; growth2: HTTP readers1/2/5 complete. Prior r2 growth1 HTTP/r1 valid case preserved | Writer HTTP/MCP; background readers **HTTP only**. Growth2 MCP/r1 cold retained, hot interrupted; MCP/r2/r5 not run. Growth5 and large HTTP/MCP/expected413 not run after stop. |

#94 completed cases use300 rows (150 existing +150 new), exact public raw/sourceRowNo readback and identical same-key receipt; representative input383788 B. These are synthetic payloads with source-derived size distributions, not business writes. Export-only1x and2x templates have10171/20192 rows and48759858/97334445 raw bytes, including150 synthetic seed rows. No whole-workload export-growth equivalence claim. Interrupted MCP hot observations were not emitted before stop; preserve its cold record and periodic telemetry, not a zero-row or latency-pass inference.

## Every observed SLO miss

Frozen authority: [budgets.md](budgets.md), unchanged. Lists<=256 KiB, loop p95<100ms/max<500ms, endpoint latency/heap limits unchanged. The table enumerates all **30 completed hot-row** misses. Frame bytes use the maximum retained frame where available; the driver-reported first frame is also retained in JSON. Small-sample percentiles remain descriptive.

| Cell | Phase | p95/p99 ms | Frame B | Loop p95/max ms | Failed gate |
| --- | --- | ---: | ---: | ---: | --- |
| `83-syn-s1-key-mcp-c5` | hot | 199.402/200.351 | 2,167,238 | 128.844/149.291 | loopP95 |
| `83-syn-s2-full-http-c1` | hot | 26.584/72.283 | 605,696 | 33.489/79.167 | response |
| `83-syn-s2-full-http-c2` | hot | 50.687/52.054 | 605,696 | 29.213/80.937 | response |
| `83-syn-s2-full-http-c5` | hot | 107.284/116.196 | 605,696 | 36.700/73.990 | response |
| `83-syn-s2-full-mcp-c1` | hot | 22.944/42.832 | 631,301 | 30.605/114.885 | response |
| `83-syn-s2-full-mcp-c2` | hot | 43.138/83.667 | 631,301 | 45.089/72.090 | response |
| `83-syn-s2-full-mcp-c5` | hot | 96.679/100.650 | 631,301 | 82.903/85.328 | response |
| `83-syn-s2-key-mcp-c5` | hot | 244.857/274.087 | 2,167,238 | 139.985/190.972 | loopP95 |
| `85-s1-default-summary-c1` | rest-default | 60.686/80.976 | 1,853,791 | 68.223/82.117 | response |
| `85-s1-default-summary-c1` | mcp-default | 75.739/80.189 | 1,959,444 | 80.675/84.804 | response |
| `85-s1-default-summary-c2` | rest-default | 101.804/125.669 | 1,853,791 | 60.981/102.302 | response |
| `85-s1-default-summary-c2` | mcp-default | 152.423/171.542 | 1,959,443 | 109.969/127.926 | response, loopP95 |
| `85-s1-default-summary-c5` | rest-default | 196.555/200.929 | 1,853,791 | 199.754/199.754 | response, loopP95 |
| `85-s1-default-summary-c5` | mcp-default | 498.525/541.843 | 1,959,443 | 448.004/448.004 | response, loopP95 |
| `85-s2-default-summary-c1` | rest-default | 72.895/90.045 | 1,853,791 | 78.119/96.862 | response |
| `85-s2-default-summary-c1` | mcp-default | 86.330/105.498 | 1,959,444 | 87.228/108.069 | response |
| `85-s2-default-summary-c2` | rest-default | 107.153/109.601 | 1,853,791 | 79.954/107.610 | response |
| `85-s2-default-summary-c2` | mcp-default | 139.264/152.294 | 1,959,443 | 94.568/103.612 | response |
| `85-s2-default-summary-c5` | rest-default | 207.301/253.095 | 1,853,791 | 127.992/130.220 | response, loopP95 |
| `85-s2-default-summary-c5` | mcp-default | 289.520/353.156 | 1,959,443 | 216.138/216.138 | response, loopP95 |
| `85-s2-relation-mcp-c5` | hot | 97.376/102.757 | 76,401 | 104.727/104.727 | loopP95 |
| `85-s5-default-summary-c1` | rest-default | 68.042/69.798 | 1,853,791 | 72.352/77.267 | response |
| `85-s5-default-summary-c1` | mcp-default | 65.516/67.780 | 1,959,444 | 71.107/72.483 | response |
| `85-s5-default-summary-c2` | rest-default | 99.573/103.239 | 1,853,791 | 71.369/72.286 | response |
| `85-s5-default-summary-c2` | mcp-default | 103.019/107.040 | 1,959,443 | 71.107/84.673 | response |
| `85-s5-default-summary-c5` | rest-default | 179.040/206.448 | 1,853,791 | 127.205/138.543 | response, loopP95 |
| `85-s5-default-summary-c5` | mcp-default | 310.072/359.702 | 1,959,443 | 308.806/308.806 | response, loopP95 |
| `85-s5-event-http-c5` | hot | 187.979/213.375 | 75,442 | 127.271/127.271 | loopP95 |
| `85-s5-point-mcp-c5` | hot | 107.066/116.570 | 39,104 | 106.299/106.299 | loopP95 |
| `85-s5-relation-mcp-c5` | hot | 103.378/114.194 | 76,401 | 113.115/113.115 | loopP95 |

The first raw-point miss `83-syn-s1-key-mcp-c5` had first-frame2167237 B (retained frames2167237–2167238 B), loop p95 **128.843775 ms**, max149.291007ms, request p95199.402292ms/p99200.351458ms. This is an explicitly requested raw point, not a list-frame budget violation. 2x key/MCP/c5 also exceeded loop p95. No transport SQL/parse/serialization phase breakdown was collected for this miss, so no cause is assigned and no diagnostic retiming was performed.

Additional cold resource observations (n1 business call, not reliable latency tails):

| Cell | Cold phase | Loop p95/max ms | Heap delta B | Failed gate |
| --- | --- | ---: | ---: | --- |
| `85-s1-default-summary-c1` | rest-default | 100.925/100.925 | 12,248,616 | loopP95 |
| `85-s1-default-summary-c5` | mcp-default | 112.919/112.919 | 10,337,200 | loopP95 |
| `85-s5-default-summary-c2` | rest-default | 125.829/125.829 | 11,864,056 | loopP95 |
| `94-r3-export2-representative` | 2x-mcp-r1-cold | 164.364/164.364 | 20,994,320 | loopP95 |

#83's original telemetry has no exact incremental-heap baseline for earlier cells; peak heap is not silently treated as delta. Later health-completion baselines and per-PID samples are retained. No blanket64MiB delta/linear-growth acceptance is claimed from missing baselines or absent5x input.

## Setup, reset and disk-stop evidence

- Seven synthetic1x calls failed readiness before business requests: WAL header2/2, no WAL/SHM sidecars on a0400 readonly bind; actual compiled health500 `SQLITE_CANTOPEN`. No timeout increase. A new independent-inode copy was checkpointed and changed to DELETE mode using Node3.53.4;39303 queries/58310 relations unchanged; integrity after preparation `ok`, FK violations0. Separate before/after per-raw-field hashes for this journal transition were not captured; distinct file hashes and the exact old compressed input/preparation commands are retained, without inventing that missing check. Old input hash and compressed failed fixture are retained. Subsequent1x key/chunk and2x/85 preparation use qualified DELETE-mode copies. Seven failed1x calls were not hidden or retimed after the disk stop.
- Five initial #94 attempts failed before API because FICLONE copy retained0400. The private fix chmods only the new independent-inode/path template0600. r2 export1 HTTP/r1 then completed n20 (preflight p9562.495ms, commit70.871ms, read6.734ms); later reset failed because owned `import_receipt.batch_id` references remained. That valid case stays valid despite the later container failure.
- Actual FK metadata was inspected. The private reset fix deletes only `import_receipt` rows linked to owned `synthetic:bench:%` parent batches, then those batches; FK remains ON. Unexpected other dependencies are rejected, not broadly removed. Every r3 reset logs integrity `ok`, FK violations0 and foreign_keys1. No business/source rows or schema changes.
- Linux FICLONE fallback caused unnecessary physical-copy pressure; the authorized host `cp -c` stage proves new inode/path, equal SHA/counts,0600, then **renames within the same RW bind**. The frozen original remains0400. All runtime driver diffs/hashes and prior snapshots remain under `drivers/`; only report docs are committed.
- Original scale2/5 generator attempts failed unique `record_correspondence.edge_key` before timing and rolled back to1x; both failure logs/hashes and owned-copy reclamation are retained. Corrected2x prefix qualification initially hit a checker-only `IN(NULL)` bug: actual ledger `id SERIAL`, PKflag1,25 NULL IDs. Full unchanged ledger/title/empty-credential comparison and explicit nullable-PK handling corrected the checker. All42 prefixes then matched. This is not an app/fixture failure; the earlier inaccurate INTEGER/non-PK account is superseded.
- **Resource stop:** `94-r3-export2-representative`, exit137, Docker OOMKilledfalse. Guard minimum **8.086 GiB**, threshold8.5GiB. Stop completed at10:07:38Z with ~8.2GiB free; later observations fell below8GiB. Final shell cgroup files were not emitted after SIGKILL; last100ms driver cgroup samples and inspect remain, not fabricated final counters. This cell is resource-stopped, not OOM and not a latency pass.
- **Reserve invariant FAILED.** Cleanup began at **5.077 GiB**, after deletion **5.077 GiB**, final observation **5.030 GiB**. Cause unknown. Exact owned paths, inodes, last-qualified hashes, logical/allocated sizes and before/after `df` are in `final-owned-cleanup.json`; two qualified disposable files were unlinked (1406689280 logical B each), without assuming CoW allocated bytes equal reclaimed physical space. Original frozen source, own sanitized seed, raw evidence, prior PG data and external services remain. No cross-owner cleanup or auto resume.

## Reproduction and handoff

Private evidence root: `/tmp/ningbo-perf-83-90/node-final-c9f149f14de21e0cc30c9ca95061f4be5c8d98b5-20261020T093145Z`. Raw completed-case samples, cold files, default/summary bodies, stdout/stderr, commands, PID telemetry, cgroup captures and Docker inspect are under `results/<cell>/`. `commands` in the [sanitized aggregate](final-96a-node-matrix.json) inventories every measured invocation and log hash. `executed-driver-sha256.txt` captures runtime overlays for later cells; initial controller sources/hash registry retain earlier versions. Current diffs/hash registry: `drivers/*.diff`, `driver-hashes.json`, `scale-private-generator.json`, `prefix-checker-correction.json`. Provenance: `source.json`, `tracked-source-sha256.json`, `archive-full-tracked-fidelity.json`, `results/artifact-manifest.json`, `*provenance.json`, `scale-2-original-prefix.json`. Cleanup/stop: `final-owned-cleanup.json`, `final-stop.json`, `guard-94-r3-export2-representative.json`, `window-release.json`.

The first miss's exact benchmark command was:

```sh
node scripts/bench-platform-query-http.mjs /fixtures/platform-1.sqlite mcp key 5
```

It ran in `ningbo-node-final:c9f149f` with the envelope above, qualified DELETE-mode input SHA-256 `e77bcd9f55f8003fc3f2ec6d0071986f381bd788c16d8cfd97c4deb967ff8aac`, and private runtime driver/preload hashes in `results/83-syn-s1-key-mcp-c5/executed-driver-sha256.txt`. Full Docker create arguments and raw observations are in that cell's `command.json`/`execution.json`/`stdout.log`. The disposable working input was reclaimed; the old WAL fixture's verified compressed bytes and exact preparation lineage remain. Reproduction is a handoff description, **not authorization to allocate or retime now**.

Fresh here: archive/image build, the listed public HTTP/MCP cells, owned-fixture qualification and source hash verification. Inherited from parent at96a:187 files/2518 passed tests/12 skipped, type/build, seven public-protocol checks and two-axis delta review0 findings. Those gates were not rerun here. No CI, production, OCR/platform collection, minimum-role/browser/#91 or full-spec acceptance claim. No PR/issues/push/merge-main/deploy actions.
