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
- CI starts runtime shards immediately alongside build/typecheck. App shards alone wait for the shared build artifact. Runtime and upgrade each use six isolated runners; app uses six, with one worker per runner. Tests never invoke a build themselves. Run `pnpm build` before local app tests that consume `.output`.
- Historical upgrade shards run for every PR except changes confined to `app/`, `components/`, `pages/`, `assets/`, `public/`, `docs/` and root README files, except `docs/adr/` changes which require historical coverage. Any other path (including workflow, test, lockfile, server, library, schema and upgrade changes) requires upgrade coverage. Main pushes, nightly schedule and manual dispatch always run all three projects. The selection is visible in the job summary; skipped historical coverage is not a historical PASS. Local `test` still runs all projects. Deploy acceptance must use a successful full run for the exact candidate; a presentation-only PR gate does not establish historical upgrade acceptance.
- Disposable fixtures use the runner’s ordinary temporary filesystem. Historical upgrade tools enforce an 8 GiB free-space floor; a small tmpfs cannot host those checks.
- The final `check` requires coverage selection, every selected shard, build and typecheck to pass. No known failure is allow-listed. Preserve per-project/shard JSON reports; use job logs if timeout prevents JSON. Each test lane retains the five-minute workflow budget measured from run-attempt start including setup and queue time; only the remaining time is available to tests. Timeout fails, never semantic success. More runners improve scheduling headroom but do not establish the 2–5 minute goal without measured CI evidence.

## Test surface

- Test through the module's real interface. Preserve independent literal business results, source bytes, hashes, ownership, privacy, atomicity and replay invariants.
- Share process/transport plumbing when multiple callers need it. Keep scenario input and independent expected results outside that adapter; avoid universal fixtures and assertions that recalculate the production algorithm.
- Retire tests for deleted behavior, transient implementation steps or unsupported corruption-and-repair paths. Record the reason in the relevant Issue; do not restore compatibility code or add exclusions just to turn a failure green.
- Keep artifacts and local test databases outside Git. Synthetic fixtures use owned temporary directories with cleanup; private evidence lanes require explicit inputs.
- Keep short default test budgets. Give a genuine long integration case its own justified budget, preserving explicit performance assertions and reporting timing separately from semantic success.

## Real-clock deep acceptance

The 121-second public readonly-snapshot expiry case is selected explicitly with `RUN_REAL_TTL_DEEP=1` when running `tests/roster/official-evidence/review.http.app.test.ts`. CI runs it in the separate `App expiry` job, alongside ordinary app shards, for roster API/MCP, evidence/snapshot implementation, owning tests/shared support, configuration/workflow changes, and all main/nightly/manual runs. Run it for snapshot lifecycle/TTL changes and before deployment; daily tests retain capacity eviction, public cursor validation, hydration-failure release and shutdown release. A daily PASS does not establish real-clock expiry acceptance. Keep its historical failures and report the deep case as UNRUN unless explicitly executed.

The real Nuxt development watcher belongs to the `deep` project. `pnpm test`
continues to include it; `pnpm test --project=deep --maxWorkers=1` runs it alone.
CI selects it for Nuxt/package/lock/test configuration, its owning tests/shared
support and workflow changes, and always on main/nightly/manual runs. The app
matrix requires the selected watcher result. A PR without that selection has no
fresh development watcher evidence. Deployment acceptance requires the full run.
