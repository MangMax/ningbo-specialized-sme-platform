# #595 final review P2: reference participation

Prepared base HEAD `43d1455b8381d48f6606be766b944b7e03dde1e1`, tree `6d9dd906c2a80f4357f267a9ac3277fd3eaf3b21`, clean tracked state verified. Implementation/test input `2a311da61e5b070f46e23561252e456cbe07408f`, tree `5f3c778bc10f001011ea7242e6ed02c2bdd0771c`. Final fetch/merge of `origin/integration/595-atomic-platform-fields` returned Already up to date at the prepared base. Subsequent changes in this branch are evidence documentation only.

The report `/tmp/595-final-review.md` identifies one P2: an accepted reference may return no observation mapping, so observation-array inspection cannot establish reference participation. The accepted platform-query plan now carries an internal participation flag to the transaction's completion verifier. Explicit references, empty subsets of existing nonempty queries, and legacy reference rows without full raw participate independently of stored observations. Full-row replay still performs synchronization; a genuinely empty query/replay stays `not_performed`. No reference writer, receipt schema, public discovery contract, database schema or projection rule changed.

## Fresh evidence

External logs: `/tmp/595-fix-evidence/`. Dependencies reused via an ignored node_modules symlink to t3-558b83c8; generated Nuxt state belongs to this checkout. Public HTTP preflight/commit uses disposable disk SQLite, independent literal field/count expectations, and direct stored raw/version comparisons. No production access.

| Requirement | Evidence |
| --- | --- |
| Relationless/empty explicit reference plus normal full row is partial | `keeps omitted reference participation partial beside a normal row without repairing the reference`; `keeps empty reference participation partial beside a normal row without repairing the reference` |
| Legacy unmapped reference is partial without implicit repair, explicit and legacy omission modes | `keeps legacy-unmapped reference participation partial beside a normal row without repairing the reference`; `keeps legacy-implicit-unmapped reference participation partial beside a normal row without repairing the reference` |
| Pure references do not write; mixed batch checks only normal version; raw/version unchanged; same-key receipt retained | The four tests above assert pure-reference zero checks/projections, mixed one checked/created version and literal 2025/待审核 fields, unchanged original relation/version, and identical retry summary |
| Normal zero eligible query and full zero-row replay retain not_performed | `keeps a normal zero-row query not performed rather than treating it as a reference` |
| Full replay, quarantine and old receipts retain meaning | Existing `certifies unique eligible versions after shared observations and repairs missing projections on full replay`; `reports quarantines and explicit references without claiming full readiness or repairing references`; `does not invent fresh completion evidence on an old committed receipt` |

Red: initial setup failed before collection because .nuxt/tsconfig.json was absent (`red.log`); nuxt prepare resolved it. `red-2.log` freshly reproduced three missing pure-reference proofs (not_performed instead of partial); `red-mixed.log` freshly reproduced all three reported mixed cases (ready instead of partial). Neither environment failure nor behavioral failures are erased.

Green: `node node_modules/vitest/vitest.mjs run --root /Users/mang/.t3/worktrees/app/t3-c8f6b749 <files> --maxWorkers=1`: 13 files / 276 PASS, exit 0 (`focused-final.log`, `focused.exit`). Files: platform-apply-projection-http, platform-dual-entry-http, platform-projection-read-http, platform-source-replay-http, import-writer-contention, import-mcp-submission, roster-import-discovery-http, platform-business-projection-http, platform-recognized-projection-http, platform-typed-archive-http, platform-business-projection-mcp, platform-recognized-projection-mcp, mcp-surface. Earlier 7-file/60 PASS preceded the final counterexample refinements and is not the final input receipt.

Final `node node_modules/nuxt/bin/nuxt.mjs typecheck` with NODE_PATH pointing to Nuxt's existing Vue Router dependency parent: exit 0, no plugin-resolution warning (`typecheck-final.log/exit`). Initial typecheck also exited 0 but printed a Volar plugin-resolution warning; retained `typecheck.log/exit`, not described as clean. No dependency/package edits.

`node node_modules/nuxt/bin/nuxt.mjs build`: exit 0 (`build.log/exit`). `NUXT_DB_PATH=/tmp/595-fix-evidence/openapi.sqlite node scripts/verify-prod-openapi.mjs --skip-build --port 3596`: exit 0, three discovery endpoints 404, health/jobs 200 (`openapi-2.log/exit`). Initial init failed because tsx was not a root dependency and initial server consequently lacked its database (`openapi-init.log`, `openapi.log`); rerun loaded the installed tsx loader explicitly and initialized a disposable database (`openapi-init-2.log`). No production service used. `git diff --check` PASS.

## Inherited evidence and limits

Prior final review and `598-platform-field-completion.md` retain exact-object full suite 6928 PASS / 12 FAIL, with independent pre-spec baseline reproduction of those exact 12 failures. Historical 6927/13, extra FAIL/UNKNOWN, interrupted and capacity-blocked runs remain historical facts. Prior full-backup/hash/integrity, full-table invariants (including real nonempty decisions), actual-ID repair/readback and desktop/390px browser operations remain inherited execution evidence with their original SHA and controlled-second-version boundaries. None was repeated or promoted to fresh evidence here.

UNRUN here: fresh browser interactions, vendor recollection, live deployed MCP transport, CI, production/deployment, new independent review. No new reviewer/subagents, parent/main merge, deployment or issue closure. Fresh MCP tests above exercise the existing tested seams; they do not imply live external MCP transport.

## Final full suite and integration readback

Fresh command: `node node_modules/vitest/vitest.mjs run --root /Users/mang/.t3/worktrees/app/t3-c8f6b749 --maxWorkers=1 --reporter=default --reporter=json --outputFile=/tmp/595-fix-evidence/full-suite.json`. Complete run, 1509.33s, exit **1**: **6933 PASS / 12 FAIL / 52 SKIP / 60 TODO**, 7057 tests; files 457 PASS / 6 FAIL / 2 SKIP, 465 total. No exclusions, assertion relaxations or unrelated fixes. Input is exactly the implementation/test content recorded above; the only concurrent repository change was this report.

Fresh extraction `final-failures.json` and `failure-comparison.json` compare each `{file, full test name}` against the inherited `/Users/mang/Workfile/598-resume-20261107/final-failures.json`: **identical set of 12**. Six comparison-input budget/boundary cases; two annual reset/readback cases; one logging policy route-catalog case; one logging usability route-catalog case; one malformed candidate raw case; one PDF evidence link case. Prior independent pre-spec baseline reproduction remains inherited, not reexecuted here. The five new cases account for 6933 versus inherited 6928 PASS. This is a bounded no-new-failure result, not full-green acceptance or authority to waive existing failures.

After completion, fetched and merged latest `origin/integration/595-atomic-platform-fields` again: `43d1455b8381d48f6606be766b944b7e03dde1e1`, Already up to date. Final diff-check passed; final report commit changes documentation only. Fresh full-suite local MCP/JSON-RPC fixture executions do not establish live deployed MCP transport. Browser operations, production, vendor recollection, CI and new independent review remain UNRUN.
