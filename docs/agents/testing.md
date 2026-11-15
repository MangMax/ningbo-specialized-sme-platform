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

## Test surface

- Test through the module's real interface. Preserve independent literal business results, source bytes, hashes, ownership, privacy, atomicity and replay invariants.
- Share process/transport plumbing when multiple callers need it. Keep scenario input and independent expected results outside that adapter; avoid universal fixtures and assertions that recalculate the production algorithm.
- Retire tests for deleted behavior, transient implementation steps or unsupported corruption-and-repair paths. Record the reason in the relevant Issue; do not restore compatibility code or add exclusions just to turn a failure green.
- Keep artifacts and local test databases outside Git. Synthetic fixtures use owned temporary directories with cleanup; private evidence lanes require explicit inputs.
- Keep short default test budgets. Give a genuine long integration case its own justified budget, preserving explicit performance assertions and reporting timing separately from semantic success.
