# #85 M3: reproducible public transport verification

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


## Scope and source

M1 entered integration at `6422c4e`. This M3 owns only `scripts/perf85-*` and this document. The verifier starts the compiled `.output/server/index.mjs`, calls real loopback REST and MCP `tools/list` / `tools/call`, and opens only a fresh synthetic SQLite fixture as read-only in the application process. It does not exercise UI, production, or a business database. Fixture generation writes to a private temporary directory; no response body or database is committed.

The frozen list target in [#82 budgets](../82/budgets.md) is page size at most 50, response at most 256 KiB, p95 at most 500 ms, p99 at most 1 s, incremental heap at most 64 MiB. These are targets, not promises. A summary contains complete scalar fields, so a single unusually long scalar or many source references can exceed 256 KiB; the application must not truncate a complete result to force the target.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/perf85-transport.mjs --verify --fixture-scale 1 --concurrency 1 --rounds 1 > /tmp/perf85-smoke.json
```

`--verify` checks all 50 returned default edges against their point, event-source and relation-source REST and MCP results. It also checks an export-context edge against its point and export-row source, append audit, candidate-only filter, invalid views, deep page 100/pageSize 1, complete summary/default scalar equivalence, and known fixture IDs/status/revision/revalidation. Deliberately corrupted status/revalidation and missing metadata must fail the verifier. Each of the four measured combinations (REST/MCP × default/summary) gets a fresh compiled server process. The first business call is cold only with respect to that process; the OS page cache is not purged. The script records the decompressed response body byte length from `arrayBuffer`, not `Content-Length`, and separately records MCP text and optional structured-content lengths. Its output contains aggregate metrics and hashes, not raw evidence.

The fixture has 120 fixed target `event_process` edges, one extra export-context edge, and `120 × scale` unrelated edges. Scale 1/2/5 therefore changes unrelated rows only. Each process edge has large archived query original, relation raw fields, correspondence provenance and append audit evidence; the export edge has large original export fields. The target filters (`enterpriseId`, `titleCode`, `type`, `role`, `ruleVersion`) and page are sent explicitly and identically to REST and MCP; summary adds `view=summary` to both, while default omits `view` on both as the contract requires. Page 100/pageSize 1 tests a stable deep page. The manifest records table counts and exact selected IDs; `--db` and `--manifest` are paired for an already prepared isolated fixture. The server is always `NUXT_DB_READONLY=1`.

## Small functional run

Compiled backend at integration `74fdaa0b4a87fa31bda9969e800121709aa5e0e2` (including M1 `6422c4e`); local script worktree before this M3 commit. Node v24.22.0 on Apple M4, 10 logical CPUs, without a container limit. Command above exited 0. Input table counts: 2 enterprises; 240 events, evidence rows, queries and relations; 241 correspondences; 240 audits. Explicit list scope selected 120 target edges and excluded 120 unrelated edges.

| Transport | View | 50-row decompressed response | MCP text | MCP structured |
| --- | --- | ---: | ---: | ---: |
| REST | default | 1,853,791 B | n/a | n/a |
| REST | summary | 17,236 B | n/a | n/a |
| MCP | default | 1,959,444 B | 1,936,101 B | absent |
| MCP | summary | 28,003 B | 24,556 B | absent |

In this exact compiled MCP toolkit result, `result` had only `content: [{type: "text"}]`; it did **not** include `structuredContent`. The verifier measures the whole frame, and checks text against structured content if a future toolkit version emits both. It does not assume that REST JSON bytes equal MCP framing bytes. Both summary responses are below 256 KiB on this representative synthetic fixture. The default responses are deliberately above it because complete source evidence remains available. The script's one hot sample per combination is a functional smoke, not a percentile, concurrency, capacity, full-distribution or container SLO result.

## Optional controlled run (not executed here)

```sh
bash scripts/perf85-container.sh --check-context
node scripts/perf85-container-selftest.mjs
# Only after the parent coordinates the single instrumentation image:
PERF85_IMAGE=parent-owned-instrumentation-image bash scripts/perf85-container.sh /absolute/private/perf85-results
# Or omit PERF85_IMAGE to build the prepared image once from this committed SHA.
bash scripts/perf85-container.sh /absolute/private/perf85-results
```

`--check-context` does not use Docker. It extracts the committed source into a private temporary context, proves that the benchmark scripts and dependencies are present, removes only the root `/scripts` rule from that private copy of `.dockerignore`, and checks that `/tests` and the business-data, credential and source-document exclusions remain. It also checks the generated build recipe. The repository `.dockerignore` is unchanged. The cleanup self-test uses a fake Docker CLI to exercise nonzero exit and SIGTERM without building or starting an image. The optional build uses the repository's current digest-pinned Node 24 base (the historical measurements above used Node 22), `python3 make g++` for native `better-sqlite3`, and pinned pnpm. `PERF85_IMAGE` lets the parent provide one shared instrumentation image containing the compiled app, `node_modules`, and benchmark scripts instead of building another; the container checks script presence before running.

The run requires a clean committed tree, creates isolated 1x/2x/5x fixtures outside Git, and writes nine aggregate JSON reports for c1/c2/c5. Each container has an owned name and labels. The script captures its exit state, OOM flag, configured CPU/memory limits, and actual cgroup values from stderr before removing it, including on failure or interruption. Each run requests one CPU, 4 GiB memory and a 2048 MiB V8 old-space flag; the application runner checks cgroup limits and records observed heap/RSS/event-loop metrics. It uses 20 hot calls per transport/view with a fresh process for each cold sample. Run only when other agents' heavy work is idle. Even 20 observations do not establish reliable p99 tails. Real-copy read-only distribution, larger sample counts, UI, and production acceptance remain separate lanes; no full #85 or parent #81/#91 closure follows from this synthetic proof.
