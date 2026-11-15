# Tests

## Ownership and naming

- Put tests under `tests/<business-module>/<feature>/`. A file covers a coherent function or set of scenarios, not one ticket or PR.
- Name files and cases after observable behavior. Keep necessary issue references in comments or GitHub Issues, not directory, file, fixture factory or suite names.
- Extend the owning suite for a regression. Create a new file only when it has a distinct responsibility.
- Keep business fixtures, assertions and independent oracles near their owning feature. `tests/support/` contains genuinely shared adapters; `tests/fixtures/` contains retained source data.

## Execution

- `runtime`: in-process domain, Vue, H3 and native SQLite tests; ordinary `.test.ts` files.
- `upgrade`: historical schema, upgrade or source-transfer tests; `.upgrade.test.ts` files. Historical adapters stay explicit and do not become current runtime fallbacks.
- `app`: real Nuxt/Nitro or business-worker process tests; `.app.test.ts` files. `http` or `mcp` alone does not establish this execution class.
- `test` runs all three projects. `test:runtime`, `test:upgrade` and `test:app` select a class without weakening the full entry point. Classify by actual execution, including fixture adapters, rather than filename guesses.
- CI starts native business groups after scope selection, alongside build/typecheck. App groups wait for the shared build artifact and a parallel development-discovery job. The latter captures real Nuxt dev OpenAPI once at the exact checkout HEAD, preserving the complete schema and metadata; every app group reads the same artifact through `TEST_DISCOVERY_ARTIFACT` and rejects a mismatched HEAD. Local runs without that environment entry still capture real dev discovery. Discovery does not extend the build job or the five-minute workflow deadline. Business checks use `scripts/business-test-groups.mjs`: a fixed directory-to-business mapping shared by matrix generation and execution. Native business jobs run runtime plus selected upgrade files; app jobs wait for build and discovery. There are fifteen native and thirteen app business groups, plus selected expiry/watcher lanes, with no numerical shards or cross-business cost sequencer. `pnpm test:groups` prints each file's business and execution class; `pnpm test:business "<check name>"` runs the exact group. Check names use `检查类型 · 模块 · 功能`, for example `应用进程 · 名录 · 工作簿导出`. Unknown directories fail matrix creation. Qualification/read ownership and workbook exports have separate business groups; enterprise ledger/annual lifecycle and record correspondence/difference decisions also have separate owners. These boundaries retain related light tests with their business rather than numerically balancing unrelated suites. Keep one worker: additional workers would compete with the suites’ native readers, renderers and export subprocesses, and parallel local discovery can race on the runner-owned capture cache. Tests never invoke a build themselves. Run `pnpm build` before local app tests that consume `.output`.
- PR scope uses `scripts/select-business-tests.mjs` without installed dependencies. An existing test selects its business's native and app groups; historical tests retain the upgrade lane. Explicit terminal statistics/log HTTP routes select their business plus interface and logging consumers; statistics also retains import, qualification and file-processing consumers. Other HTTP routes remain full coverage because their cross-business workflows are not isolated. Shared implementation (`lib/`, `server/utils/`, workers), database/schema, dependencies, test resources, CI configuration, deleted source/test paths and every unknown path select all groups including deep tests. This is a conservative boundary map, not an inferred import graph: qualification implementation changes still cover every downstream list, statistics and export consumer. Add narrower source rules only with verified consumer coverage.
- Ordinary documentation selects no business groups; ADRs select full coverage. Rename detection is disabled for scope calculation so both old and new paths are checked. Main pushes, nightly and manual dispatch always select full coverage. Build, typecheck, static checks and development discovery remain mandatory. The CI summary lists selected and unselected groups and selection reasons; unselected means not run, never passed. Empty native/app matrices skip their jobs, and the final gate accepts a skipped job only when its successful scope output explicitly selected zero groups. Any selected job failure, cancellation or unexpected skip fails the gate.
- `scripts/select-upgrade-tests.mjs` controls historical inclusion within selected business groups. Production server/lib/db source, ADRs and unclassified paths conservatively include history. Existing ordinary runtime/app tests can skip history. Deployment acceptance requires a full successful run for the exact candidate; retain offline entry points until their supported recovery path is explicitly retired.

- Disposable fixtures use the runner’s ordinary temporary filesystem. Historical upgrade tools enforce an 8 GiB free-space floor; a small tmpfs cannot host those checks.
- The final `check` requires coverage selection, every selected business group, build and typecheck to pass. No known failure is allow-listed. Preserve per-business JSON reports; use job logs if timeout prevents JSON. Each test lane retains the five-minute workflow budget measured from run-attempt start including setup and queue time; only the remaining time is available to tests. Timeout fails, never semantic success. More runners improve scheduling headroom but do not establish the 2–5 minute goal without measured CI evidence.

## Test surface

- Test through the module's real interface. Preserve independent literal business results, source bytes, hashes, ownership, privacy, atomicity and replay invariants.
- Share process/transport plumbing when multiple callers need it. Keep scenario input and independent expected results outside that adapter; avoid universal fixtures and assertions that recalculate the production algorithm.
- Retire tests for deleted behavior, transient implementation steps or unsupported corruption-and-repair paths. Record the reason in the relevant Issue; do not restore compatibility code or add exclusions just to turn a failure green.
- Keep artifacts and local test databases outside Git. Synthetic fixtures use owned temporary directories with cleanup; private evidence lanes require explicit inputs.
- Keep short default test budgets. Give a genuine long integration case its own justified budget, preserving explicit performance assertions and reporting timing separately from semantic success.

## Real-clock deep acceptance

The 121-second public readonly-snapshot expiry case is selected explicitly with `RUN_REAL_TTL_DEEP=1` when running `tests/roster/official-evidence/review.http.app.test.ts`. CI runs it in the separate `深度测试 · 名录 · 快照真实过期` job, alongside ordinary app groups, for roster API/MCP, evidence/snapshot implementation, owning tests/shared support, configuration/workflow changes, and all main/nightly/manual runs. Run it for snapshot lifecycle/TTL changes and before deployment; daily tests retain capacity eviction, public cursor validation, hydration-failure release and shutdown release. A daily PASS does not establish real-clock expiry acceptance. Keep its historical failures and report the deep case as UNRUN unless explicitly executed.

The real Nuxt development watcher belongs to the `deep` project. `pnpm test`
continues to include it; `pnpm test --project=deep --maxWorkers=1` runs it alone.
CI selects it for Nuxt/package/lock/test configuration, its owning tests/shared
support and workflow changes, and always on main/nightly/manual runs. The app
matrix requires the selected watcher result. A PR without that selection has no
fresh development watcher evidence. Deployment acceptance requires the full run.

## Retired historical stage acceptance

The frozen recognized writer and business-process shadow comparison no longer have standalone acceptance suites. The recognized-directory shadow suite remains because it also exercises a current business predicate. Current collection writes belong to `platform/collections/collection-command.test.ts`; historical replay belongs to `platform/collections/collection-target-replay.upgrade.test.ts` (historical input) and native business owners. Historical schema expansion, source bytes/IDs/ownership, full migration, rollback/resume, independent CLI and migration-open boundaries remain supported and tested. Do not use frozen readers as current runtime fallbacks.
