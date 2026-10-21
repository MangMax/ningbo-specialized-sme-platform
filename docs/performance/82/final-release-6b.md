# Final release verification — 6b00767

The authorized final checks found no blocking correctness defect or ordinary SUMMARY regression in the inspected evidence. Fresh full tests and the actual 390px product interactions passed. This report applies the user-approved [acceptance v2](acceptance-v2.md); it does not convert historical misses into passes or establish universal performance, full-capacity, CI, production, #91 or full-spec acceptance. The [sanitized aggregate](final-release-6b.json) records the exact scope.

Verified source: `6b0076761d50af370a373be686754a69998993c4`, tree `e4f4472ac94609b19f4880ac8c856db8c800ae6d`. Its non-document application tree equals `b76c04cb95d6a6acf11a4fb4ba31ff61e639a699`. There were no application changes, new build, typecheck repeat, benchmark repeat or profiling run in this final verification. Existing compiled Linux Node **24.22.0** image `ningbo-node-combined:b76c04c`, Docker inspect/container image ID **`sha256:6ba20706dfc8ec8237eac880221856126ddf1319c6b4338a2e4d0cb70050569b`**, was reused; host Node was **24.22.1**. Image source authority remains b76, not the later documentation commits.

## Fresh full tests

At unchanged 6b, the serial command below exited **0**: **3030 passed, 12 skipped, 0 failed**, across **245 passed / 2 skipped files**, duration **352.03s**. Raw JSON marks the two all-skipped files as passed; assertion counts and the stdout file summary retain that distinction.

```sh
pnpm test --maxWorkers 2 --reporter=default --reporter=json --outputFile=/tmp/ningbo-perf-83-90/release-6b00767-20261021T140030Z/full-tests.json
```

The 500ms host guard's observed minimum was **13,738,872,832B**, above the 12GiB stop threshold. Exact command, source/tree, exit, stdout/stderr, counts and samples are retained in `test-{command,execution,counts,guard}.json` and `full-tests*` under the private root below. No source edits occurred during the run.

## Fresh actual product UI at 390px

The T3 Preview used the compiled product route `/enterprises/1` at **390×844 CSS pixels**, then navigated within the SPA to `/enterprises/2`. It used one new, contract-valid synthetic database, actual Node `useDb` migration authority with **28 ledger entries**, FK/integrity qualification and a 0400 freeze before browser requests. The final 61,177,856B fixture SHA was `c04e2ad915ddd7d1085c011a20aedb4e036fafcde7058ce792fbaf829e317088`. Original business sources were not used or changed.

A private pass-through proxy explicitly supplied an old summary and held one real point response. HTML, JavaScript and normal APIs came from the actual compiled app. These are functional fault-injection checks, not UI latency measurements:

| Planned scenario | Observed result |
| --- | --- |
| Lazy expansion and revision rejection | Initial 121-edge summary advertised revision 2 and omitted actual edge 242. **Zero point requests before expansion**. On expansion, actual point revision 3 was rejected; the unknown/error state and official `0.pdf` / page 1 source remained visible. |
| Explicit retry with new revision/edge | Retry fetched the current 122-edge summary at revision 3 **before** points 1, 242 and 121. New edge 242 and its source appeared; the error cleared. |
| Stale owner protection | Owner 1 point response was held after upstream completion. SPA navigation loaded owner 2 first; the full, unchanged owner 1 response then arrived without disconnection. Owner 2's heading/event state remained unchanged; old source content did not leak into the new owner. The intentional hold is not latency evidence. |

All three scenarios had no horizontal overflow (`scrollWidth = innerWidth = 390`). Wire request IDs/body hashes, actual body receipt and UI states are linked by `browser-functional-verdict.json`, `release390-*.json` and `results/browser-live/{requests.jsonl,api-*.json}`. The prior actual **1280px** b76 proof is explicitly **INHERITED** through exact application equality; it was not repeated. This fresh proof supersedes earlier reports' 390px/revision **unrun** status prospectively.

Screenshots, visually inspected:

- Initial: `/Users/mang/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvi758om-51e44954.png`
- Revision rejection: `/Users/mang/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvi762zt-a131ffdc.png`
- Recovered new edge: `/Users/mang/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvi76c6z-09d5374c.png`
- Owner 2 after late response: `/Users/mang/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mvi79mtt-86558608.png`

## Light review of retained runtime evidence

This was a metadata/body/identity review, **without retiming**. Existing b76 image evidence is inherited by 6b's identical application tree, with each original run's scope retained:

| Evidence | Retained gate outcome |
| --- | --- |
| #94 representative export-growth and large HTTP | All **21 rows** met their original observed gates; maximum hot loop p95 **24.887295ms**, maximum hot loop max **127.533055ms**. |
| #83 explicit SUMMARY | **6 rows**, all recorded gates met; maximum request p95 **20.059459ms**, frame **11,976B**, heap delta **20,079,848B**. |
| #85 explicit SUMMARY | **18 rows**, all recorded gates met; maximum request p95 **101.001292ms**, frame **28,002B**, heap delta **42,917,520B**. Actual HTTP bodies at export scales 1/2/5 contain 50 of 120 rows with identical canonical hashes and no nested raw archives. |
| #85 deep SUMMARY | **18 rows**, all recorded gates met; maximum request p95 **83.945791ms**, frame **713B**. |
| Compiled recovery/cache/auth | Lost post-COMMIT IPC and same-key exact 300-row replay, two-instance ten-domain-write/TTL checks and #95 auth/boundary/negative-413/HTTP fallback retain their successful original evidence. All three inspect files match image ID 6ba20706… and exit 0 / OOM false. |

The complete raw/current and historical [combined report](combined-runtime-b76.md) remains authoritative. #83/#85 legacy FULL frame violations, near-threshold raw event-loop excursions and payload-related heap observations remain recorded v1 misses and v2 **RISK / CONTRACT-EXCLUDED** where applicable. The **13,271,319B enterprise DEFAULT FULL** consumer/projection risk remains explicit; these UI checks are not a UI performance pass. Whole-application 5x and other resource-rejected scopes remain **RESOURCE-UNVERIFIED**. Main and Node changed between historical runs; no isolated causal speedup claim follows.

## Private setup lineage, resource control and cleanup

The initial resource forecast rejection was retained without allocation. Parent-owned cache/image cleanup restored capacity; the unchanged forecast remained **2GiB physical allowance + 12GiB headroom = 15,032,385,536B**. Host and Docker free-space checks preceded allocation/container/scenarios. The app, descendants and private driver retained one combined **1CPU / 4GiB / memory-swap 4GiB** cgroup, main old-space 2048MiB and bounded enterprise child 256MiB / semi-space 16MiB. Per-PID resources, cgroup and inspect files were captured before owned-container removal.

Two earlier private attempts remain **PRE-API/browser setup failures**, not application or latency failures: r1 reopened a cached closed client (prepare exit 1, OOM false; qualifier/freeze not reached); r2 prepared and qualified successfully but the controller read an old manifest path (no freeze/browser/API). The approved private corrections separated generator process lifetime and derived paths from one folder object. The retained tiny actual lifecycle integration proof established same-path/inode/current-28-ledger/FK behavior before the final large allocation. No app/schema/source-business fix was made. Exact reached-stage flags, original errors, private runtime diffs/hashes and cleanup records remain intact.

Final prepare, qualification and browser execution all exited **0 / OOM false**. Their observed guard minima were **18,367,602,688B**, **18,428,825,600B** and **18,412,212,224B** respectively. All four newly owned database files (r1, tiny lifecycle, r2, final) were hashed and reclaimed after their reached-stage evidence was saved; final fixture hash still matched its pre-request freeze. This records logical removal, not an inferred physical-space gain. Own-container label inventory is empty, the owned preview tab is closed, and no foreign resources were cleaned. At inventory `2026-10-21T14:25:00.972236Z`, host free space was **19,517,919,232B**. Active sampled guards do not prove an unobserved idle-host invariant; historical disk breaches remain unchanged.

Private evidence root: `/tmp/ningbo-perf-83-90/release-6b00767-20261021T140030Z`. Key pointers: `final-owned-inventory.json`, `cleanup.jsonl`, `browser-final-{static-preflight,fixture-freeze,evidence-existence}.json`, `browser-r{1,2}-failure-classification.json`, `retained-evidence-light-review.json`, and `results/browser-live/` (raw bodies, resources, cgroup, inspect, commands and driver hashes). Final private controller SHA: `74b411ce5f16f2b74ea7952439690091e312a7d0cb88ff4d961d302ed6ad68f3`. Earlier source-bound evidence remains under `/tmp/ningbo-perf-83-90/combined-b76c04c-20261021T124757Z`.

Only this small report and its sanitized aggregate are committed. Parent retains responsibility for review and authorized MATCHHEAD merge; this worker did not push, mark PR ready, merge or change issues.
