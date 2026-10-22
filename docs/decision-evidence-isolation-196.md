# Decision/evidence read boundary (#196)

The former runtime cycle was `decision-lifecycle-102 -> evidence-impact-113 ->
decision-lifecycle-102`. Evidence tokens only need the latest decision head, so
both modules now import `decision-lifecycle-102/head.ts`. This read-only module
owns the existing narrow head SELECT and shared exact-scope predicate. The writer
keeps its original `latestDecisionHead102` export for existing consumers.

The reader uses the supplied database or transaction executor. It opens no handle
or transaction, adds no cache, and preserves recorded-at/ID ordering, withdrawal
heads, and the four projected columns. Decision writes and evidence projection
retain their existing immediate transactions, SQL, replay checks and audit rules.
No table, migration, public API, domain rule or source fact changes.

Verification uses actual Nuxt REST/MCP with isolated synthetic SQLite, including
replacement/withdrawal history, ready and unfinished evidence, stale versions,
auth rejection, same-key replay and injected transaction failures. The public
review suite additionally checks withdrawal IDs in live tokens and late evidence,
and both transports failing before a review receipt can commit. The added
assertions use public reads; SQL triggers inject faults into the synthetic fixture.

Run the focused suites serially:

```sh
pnpm exec vitest run tests/decision-lifecycle-102-http.test.ts tests/evidence-review-114-http.test.ts tests/evidence-impact-113-http.test.ts tests/evidence-impact-113-migration.test.ts tests/decision-lifecycle-102-mcp-handler.test.ts --maxWorkers=1
pnpm typecheck
pnpm build
```

The issue handoff at `/tmp/ningbo-spec190-handoff/issue-196/` retains exact revisions,
commands, JSON test reports, and the static/evaluated import probe. The probe
excludes type-only edges and loads both modules in fresh processes in both entry
orders. Baseline cycle assertions fail; the extracted reader removes the reverse
path. Business tests characterize preserved behavior rather than inventing a
behavioral failure for a dependency-only change. These checks do not establish
full-suite, CI, browser, production, capacity or parent-spec acceptance.
