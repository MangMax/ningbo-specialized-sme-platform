# Combined Linux runtime continuation — b76c04c

This is a **partial, resource-blocked performance handoff**, not full-spec acceptance, issue closure, PR readiness, CI or production evidence. Application source remains `b76c04cb95d6a6acf11a4fb4ba31ff61e639a699`. Only this report and its [sanitized aggregate](combined-runtime-b76.json) are committed. The previous reports and all historical misses, setup failures and disk breaches remain unchanged.

Private evidence root: `/tmp/ningbo-perf-83-90/combined-b76c04c-20261021T124757Z`. Commands, individual samples, bodies, fixture qualifications, phase/lifetime histograms, process resources, guards and Docker inspect files remain there. No business DB, source document, credential or captured response body is committed.

**Exact source and runtime.** The existing worktree `t3-83467138`, branch `t3/node-perf-83-90-matrix`, fast-forwarded to b76 before this continuation. One image was built from the complete Git archive, including tracked scripts/tests despite the repository `.dockerignore`. No host `node_modules` was used. The original image qualification found **0 mismatched tracked files** among 1,438 tracked files. Private runtime driver overlays have separate per-command hashes and final manifests; they are not application source changes.

| Identity | Value |
| --- | --- |
| Image tag | `ningbo-node-combined:b76c04c` |
| Docker `inspect.Id` / container `Image` | `sha256:6ba20706dfc8ec8237eac880221856126ddf1319c6b4338a2e4d0cb70050569b` |
| Pinned base | `node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` |
| Actual compiled Linux Node | `v24.22.0` |
| Git archive SHA256 | `7276b49a0f56d81bb024b9fc1efd69e6180857559ed2dfe33382fa16be446756` |
| Compiled server entry SHA256 | `a007c458211f85f9f97cf663cb34b49b52bfb4cf8e23afb004ca7a7070a41077` |
| Native SQLite module SHA256 | `8ba771f284dfd9430e3ef8e2ffc373ed7cc5a92fc7c4c0c7baf39dd672863485` |
| Current title migration | `0027`, index 27, timestamp `1792400021008`, SQL SHA256 `b12317fa3d39a2891893efccbeffa6a6c1a84c28083ddfbb1136a5e16f0256b0` |

`build-manifest.json`, `image-inspect.json`, `results/artifact-manifest.json` and `all-tracked-source-sha256.json` retain the Dockerfile, all tracked/compiled files, native and worker identities. The owned bare provenance Git has its own populated index, no shared host Git configuration or credentials. Published migrations 0–26 were retained; all new bootable fixtures use actual current Node migration authority with **28 ledger entries**, not the historical 25-entry query-only spike artifacts.

All application descendants and the driver shared one 1-CPU / 4-GiB cgroup, memory-swap also 4 GiB. Main old-space remained 2,048 MiB; import child old-space 256 MiB / semi-space 16 MiB. Driver CPU and per-PID heap/RSS were recorded separately. Combined app/child figures sum per-process maxima within each fresh server scenario; heap samples at 100 ms can miss synchronous peaks. These observations are not proof of an unsampled maximum. No budget, timeout, heap flag, durability or public default/raw contract was relaxed.

**Fresh functional evidence.** Compiled HTTP and MCP tests passed on this exact image: real worker COMMIT-result loss followed by SIGKILL produced an unknown outcome, the durable receipt remained committed, manual same-key replay returned the exact result hash, all 300 raw/source-row values and six MCP source samples matched, and history stayed at one without duplicates. #95 separately verified token boundaries, exact 4 MiB admission, +1 byte and 5,625,843-byte MCP negative 413 with no receipt side effect, and authorized HTTP fallback/replay. Two-instance cache tests passed all ten public domain-write invalidations, REST/MCP equivalence and TTL checks.

Pointers: `results/compiled-ipc-recovery/ipc-recovery-results.json`, `results/compiled-95-auth-recovery/stdout.log`, `results/compiled-two-instance-cache-writes/stdout.log`. Each retains command/inspect/cgroup/driver hashes. The parent’s b76 **3030 pass / 12 skip, typecheck and build** are explicitly inherited host-Node-24.22.1 evidence. They were not rerun because no application source changed. They are distinct from fresh compiled Linux Node 24.22.0 execution.

**#94: 21 current measured scenarios meet every observed gate checked.** Large-body HTTP at readers 1/2/5 and representative HTTP/MCP at readers 1/2/5 for export growth 1/2/5 each retain 20 hot samples, cold/warmup observations and all phase/resource metrics. Before any request, all **22 logical request hashes** and export counts matched the frozen historical inputs. Canonical physical DB hashes were newly frozen for the 28-migration source. Growth is export-only workload growth, not whole-business-domain 5x proof.

| Large HTTP readers | Hot loop p95 / max (ms) | Preflight p95 / p99 (ms) | Commit p95 / p99 (ms) |
| --- | --- | --- | --- |
| 1 | 13.418495 / 75.104255 | 269.346834 / 417.801250 | 308.290959 / 384.879876 |
| 2 | 14.884863 / 68.485119 | See aggregate | See aggregate |
| 5 | 14.532607 / 96.010239 | See aggregate | See aggregate |

The aggregate checks each row’s hot/cold loop p95/max, preflight/commit/read p95/p99, response bytes, main incremental heap, and conservative observed app-plus-children heap/RSS. The largest combined RSS upper figure is 819,765,248 B. Each workload round verifies the new row and `sourceRowNo` plus exact same-key replay; the separate functional IPC lane supplies the all-300-raw proof. Large MCP rejection is a separate #95 negative functional path, never a latency pass. Current main and Node 24 differ from the historical Node 22 source, so this is **not an isolated causal speedup claim for 9928’s isolation change**. The original three large-HTTP loop misses remain historical failures.

The initial continuation’s #94 staging-prefix failure occurred **before Node preparation and before any API request**, OOM=false. Its copy inode/hash and cleanup are retained. A private prefix-only correction used unique r2 output names. Representative 1x used a separately frozen r3 plan; it did not overwrite r2 evidence. Every owned template was qualified/logged/hashed and reclaimed serially.

**#83: 24 current synthetic-1x scenarios executed, with unresolved gates.** The tracked generator produced 39,303 queries / 58,310 relations through current Node `useDb`; integrity/FK/count/raw-byte/selected-row proofs preceded DELETE-journal/close/0400 freeze. The physical SHA was `7654620a71461c593dd98d012184d07562c913fa0ed09bdfe21d6852bf802852`. Full/key/chunk/summary × HTTP/MCP × concurrency 1/2/5 retain all 20 hot samples and full bodies. All executions exited 0, OOM=false; this is not blanket SLO success.

| Remaining hot loop miss | p95 / max (ms) |
| --- | --- |
| MCP exact key `synthetic:1000`, c2 | 101.056511 / 116.850687 |
| MCP exact key `synthetic:1000`, c5 | 126.287871 / 136.839167 |

All six default FULL list rows exceed 256 KiB: HTTP 605,672 B / MCP 631,276 B. They remain compatibility-budget misses. The explicitly requested **MCP raw point frame of 2,167,237 B is separately qualified**, not counted as a list-byte violation. Other checked current 1x gates are in the aggregate. Fresh-process readiness succeeded for these cells; prior WAL/readiness/setup failures remain separate evidence.

Synthetic 2x was **not allocated**: observed host free 19,223,416,832 B was below even the 22,548,578,304-B 9-GiB-plus-12-GiB floor. Using the measured 1x file for DB+WAL+temp plus 512 MiB strengthens the required free space to **22,590,709,760 B**. The fixture was not reduced. Synthetic 5x is not supported by this generator; no counterfeit 5x lane was substituted. Current real-copy title-filter/summary and whole-workload 5x remain unrun.

**#85: 144 current synthetic scenarios, 19 distinct rows with gate failures.** Scales 1/2/5 retain selected 120 rows and unrelated 120/240/600 rows, HTTP/MCP, c1/2/5, and 20 hot samples for default FULL, explicit summary, nonempty deep page, point, event source, relation source, nonempty audit page 1 and candidates. Every generated archive passed the current exported Zod schema before requests; selected/unrelated source paths are distinct. Candidate scope was counted before requests: event/evidence/query/relation/prior/audit each 1, exports 0, union upper 6, pair count 1. It is not inferred from page size. All 144 API executions succeeded; all fixture copies were reclaimed.

The following counts **overlap within those 19 rows and must not be added as distinct failures**:

- 18 default FULL response-byte failures: 1,878,341 B HTTP / 2,014,342 B MCP, unchanged contract.
- 8 hot loop-p95 failures, listed below.
- 3 cold loop-p95 failures: 5x MCP default c1 118.030335 ms; 5x HTTP default c2 154.796031 ms; 5x MCP default c5 103.415807 ms.
- 1 incremental-heap failure: 2x MCP default c5 71,256,104 B >64 MiB.

| Scale / transport / mode / concurrency | Hot loop p95 / max (ms) |
| --- | --- |
| 1 / MCP / default / 2 | 111.345663 / 118.226943 |
| 1 / HTTP / default / 5 | 158.072831 / 161.742847 |
| 1 / MCP / default / 5 | 208.273407 / 210.763775 |
| 2 / HTTP / default / 5 | 110.100479 / 128.122879 |
| 2 / MCP / default / 5 | 235.929599 / 382.205951 |
| 5 / HTTP / default / 5 | 144.965631 / 146.014207 |
| 5 / MCP / default / 5 | 195.428351 / 395.051007 |
| 5 / MCP / point / 5 | 101.122047 / 101.122047 |

Explicit summary and the other rows’ checked gates are recorded individually in the aggregate. These are synthetic workload observations, not business-semantic scaling proof. The generator’s query/relation `createdAt` defaults vary across fresh fixtures; IDs/raw strings/distribution were fixed, but cross-scale full-result identity must not be claimed.

**Diagnosis and retained failures.** Current phases use the tested pre-window drain then reset, an end tail inside the window, and an independent lifetime histogram. Earlier cumulative/hot attribution corrections do not delete earlier observations. Every captured body is validated; request completion includes full body receipt. Small n20 quantiles do not establish reliable tails. App CPU, driver CPU, cgroup throttling and overlapping native timing are kept separately.

Diagnostic r1 failed after Node qualification because the private controller used ROOT rather than `ROOT/results`; no diagnostic API, freeze or turn trace existed. R2 correctly rejected full selected-row hashes before API because auto-generated timestamps differed. Both copies were reclaimed, prepare/qualify exit 0 and OOM=false. Generic cleanup prose is superseded by explicit evidence-existence classifications. Static controller checks caught a manifest-key mismatch before allocation; corrected paths/keys/imports/output namespaces/syntax/cleanup fields then passed.

The authorized r3 froze **only the exact 50 participating query/relation timestamps retained in the original HTTP full body**, without guessing missing values or omitting fields. Before any HTTP trace, full selected-row SHA matched the original and the current offline public handler’s full-50-list and point canonical result hashes exactly matched retained results. Offline checks are not HTTP timing evidence. The subsequent bounded diagnostic exited 0/OOM=false and its copy was reclaimed.

For hot MCP default, PID 38’s longest recorded PROMISE callback used 133.669 ms **process** CPU over 198.8195 ms wall, with 47.657 ms cgroup throttling; native union was 124.063235 ms wall, outer native 77.305 ms process CPU and unaccounted 56.364 ms process CPU. HTTP default’s largest callback process CPU was 35.708 ms; MCP point’s was 43.553 ms. These include instrumentation overhead and other V8 threads. They do **not** establish intrinsic main-thread SQL/app blocking. No speculative app/SQL fix was made. The point diagnostic’s 81.985535-ms loop p95 does not clear the original 101.122047-ms miss.

The one further authorized precise question—main-thread CPU beside process CPU, with low-overhead turn boundaries and no primitive tracing/profiler—was **not run** after the resource rejection. `process.threadCpuUsage` was observed only on host Node 24.22.1; availability on the actual image was not executed and is not assumed.

**Actual browser, partial.** T3 Preview used the real compiled `/enterprises/1` product route, synthetic read-only fixture and 1280×800 viewport. Correspondence summary loaded 121 edges /41,773 B with zero point reads before expansion. A private passthrough proxy injected point-ID-1 503 responses only; the original compiled HTML/JS and source DB were unchanged. The page retained official evidence and “不能据此判断没有来源”; explicit retry fetched summary before points 1/121 and recovered. Scroll width stayed 1,280. Screenshots and complete request/response hashes remain private.

`GET /api/roster/enterprises/1` default full returned **13,271,319 B** during this functional browser exercise. This exact seam/intent is retained separately; it is not a UI performance pass or a measured current #84 row. Desktop revision-mismatch and **390px** verification remain unrun. The browser service was administratively stopped after the next-scenario forecast failed; Docker exit **137, OOM=false** is not an application crash, latency pass or OOM. The frozen 60-MB fixture hash matched before immediate cleanup; the owned T3 tab was closed.

**Resource stop and remaining authority.** Every allocation/container/scenario required a fresh host and Docker full-physical forecast leaving 12 GiB, with 500-ms active host guards and an 8-GiB hard floor. New active observations bottomed at 14,052,159,488 B (>12 GiB); this does not prove unobserved idle-host invariance. Before the next browser/thread-CPU scenario, host free was **14,055,190,528 B**, below **15,032,385,536 B** required for 2 GiB +12 GiB. No further fixture allocation/test/build/timing proceeded. The cause of host space movement is unknown; no external resources were removed or blamed.

The 2-GiB small-lane forecast must fit afresh before 390px/revision/thread-CPU continuation; #83’s 5-GiB diagnostic requires 17 GiB; synthetic 2x needs the stronger capacity above. A conservative whole-workload 5x DB+WAL+temp allowance of 23 GiB would require **35 GiB free** with headroom and was not allocated. No unowned Docker prune, PG-data deletion or external-service stop occurred.

`final-owned-inventory.json` records zero remaining owned containers and all 13 exact owned-copy cleanup entries. `final-source-preservation.json` records unchanged original source SHA `2c72355ebe602b24d9c0a08561957481d97b083a78aae51995e29e58e4064430`, mode0400, inode/mtime, and unchanged sanitized PRE0025 seed SHA `43f99fbd164c2b34a06a8d225ffc5f6d45faf7d05be6fafeb242768ee9a6ab28`, mode0600. Those file-only hash reads were already in flight at the report hold; no subsequent large hash pass was started. Neither source was opened by SQLite. Cleanup never touched frozen originals, retained backups, PG data, raw sources or other owners.

Reproduction starts from the exact image and the private `run83.py` / `run85.py` frozen plans, qualifying a new owned fixture only after the capacity forecast passes. Exact missed-cell arguments include `scripts/bench-platform-query-retained.mjs /fixtures/83-current-1.sqlite mcp key 5` and `scripts/bench85-current.mjs /fixtures/85-current-5/roster.db /fixtures/85-current-5/manifest.json <new-private-output> 5`. Recreated fixtures require the retained identity guards; deleted disposable paths are not currently runnable DBs. Every original Docker command is in `results/<cell>/command.json`; actual driver hashes/diffs are retained independently. No hidden retiming or budget broadening occurred.

Current #83/#85 loop misses, default FULL byte-budget conflicts, missing scale/browser/thread attribution lanes and historical #84/#86/#89/PG boundaries remain open. The earlier #86 positive synthetic proof remains historical and is not relabelled as fresh b76 performance. This handoff releases only the worker’s exclusive window after owned service/fixture cleanup; parent review and acceptance remain separate.
