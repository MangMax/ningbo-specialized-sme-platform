# #667 review fix: internal chunk key isolation

Baseline: ecf75f5458eb5870b22114ac368561cee9a605f1 (exact initial HEAD and local integration/667-file-segments). `git merge-base --is-ancestor` passed; merging latest local integration reported already up to date. No main/integration branch mutation, production access, issue closure, delegation or review loop.

## Findings

P2 confirmed independently through real authenticated HTTP handlers and isolated SQLite. Before the fix, both accepted public plans `run:0` and `run` preflight successfully, but committing `run` chunk 0 returns 409. Reverse ordering also returns 409 when creating the suffix public plan. `first-fail.log` is the immutable first run (5 failed / 24 passed); `green.log` is the immediate post-fix run (29 passed).

Plan ledger keys remain `file-event-sync:<fileId>:<publicKey>` for existing persisted-plan compatibility. Correction chunk keys now start with `file-event-sync-chunk:`. Those fixed prefixes differ before any user-controlled bytes, so no accepted public string can make a plan equal a chunk key. Within the chunk namespace the numeric file ID and final numeric chunk suffix delimit the unchanged complete client key. Public validation is unchanged, including arbitrary punctuation, Unicode and the 120-character boundary. Existing completed chunks return stored receipts before attempting a new correction; incomplete chunks are atomic and roll back their correction ledger along with business changes.

Regression coverage:

- `replays each completed chunk as its original immutable receipt after later chunks`: public `run:0` reserved first, `run` updates 100 then 1 events, injected second-chunk SQLite failure, original-request resume, both immutable chunk receipts, progress readback and exactly one audit per updated event.
- `accepts public key %s after a correction without namespace aliasing`: ordinary/suffix/multi-colon/Unicode/maximum-length keys; reverse ordering, unchanged suffix plan, stable replay, different-basis 409 and exactly one audit for the event.

Low-priority duplicated OpenAPI metadata: deferred with evidence, not a hard standards violation. Installed Nitro `node_modules/nitropack/dist/rollup/index.mjs` handler-meta transform uses `astToObject` on `defineRouteMeta` arguments; it handles object/array/literal nodes only, not imported schema expressions or function calls. Direct schema-derived metadata would silently disappear. A generation pipeline would broaden this narrow fix. All four route metadata files and their generated-contract inputs remain byte unchanged.

## Validation boundaries

Fresh affected suite: file-event-sync-671, roster-event-correction, roster-event-correction-304, agent-http (148/148); typecheck passed. Final build and isolated production-build OpenAPI verification are recorded in the PR handoff. These are controlled fixtures, not official-data or live-production evidence.

Inherited: earlier #667/#671 UI/workbook acceptance is context only, not re-executed here. UNRUN: browser desktop/390px, full repository suite, CI and independent review. No UI or public schema changes.
