# Task summary consumers (#134 M2)

At the M2 baseline (`59462b101b93b530740b4ce3b4bb108288e3b6b5`), the repository has two executable generic job-read consumers:

- `scripts/reconcile-live.mjs --base-url`: submits the existing reconcile job, polls `GET /api/jobs/:id?view=summary`, then reads `GET /api/jobs/:id` at a terminal state. The full detail is authoritative for state, error and result. If a domain retry reopens the same ID between reads, polling continues. Failed/cancelled partial receipts still go to `--out` and exit nonzero. Submission authorization, local execution, polling interval and runner ownership are unchanged.
- `scripts/perf-82/run.mjs`, scenario `jobs`: requests `GET /api/jobs?view=summary&limit=25`. `pageSize` is not the jobs route's limit parameter. The scenario measures the summary list without hydrating each row. Historical measurements using the old full-list request must remain labeled as such.

Search covered pages, components, composables, scripts and shared types. There is no task-center UI or other OCR/platform generic-job polling consumer in this tree. The perf worker's route registration, OpenAPI verifier, documentation, backend calls and legacy-contract tests are not list UI consumers. Domain batch-query status/result endpoints remain their own API; this change does not replace them with generic jobs.

## Future #120 task-center seam

#120 is not merged in this baseline. Its eventual consumer must explicitly select the additive summary view; this document does not claim that UI has migrated.

- Use `JobSummaryDto` from `lib/job.ts` for list and ID polling. List requests use `view=summary` and `limit<=50` (existing `kind`/`state` filters and `total` remain available). Do not request full detail for every list row.
- Display summary progress, times, kind/state and cancellation eligibility. `capabilities.cancel` is eligibility only: the existing authenticated DELETE endpoint and best-effort running cancellation semantics remain authoritative. Discover submission kinds through `/api/jobs/kinds`; there is no generic retry capability/endpoint.
- Load `detailUrl` when opening result/error/params, or once terminal result consumption is required. `resultSummary.available` includes running checkpoints and failed/cancelled partial results; it never proves completeness or success. The summary error is a fixed notice, not the full diagnostic.
- Preserve full detail receipts, OCR page order, platform segments and relative artifact references; never reconstruct them from summary metadata. Re-read detail state when concurrent domain retry can reopen an ID. Full details retain the M1 output redaction contract.
- Verify the actual browser requests, list/detail refresh and return navigation at desktop and 390px when that UI exists.

## Verification boundary

CLI regressions execute the real child process against a loopback HTTP fixture with synthetic receipts. They prove summary polling and lazy result/error consumption, not production timing, queue execution or storage cost. M2 changes no backend, queue, database or Vue UI.

The performance runner must use an isolated verified terminal-only snapshot before its first jobs request: the unchanged runner startup may attempt recovery writes for queued/running tasks. Retrying a failed first read on a readonly pending snapshot is not valid acceptance. Parent acceptance must bind the final combined SHA to real SQLite/public HTTP measurements, response size, deep history/result growth, heap/RSS and 1/2/5 concurrency latency. Targeted tests do not establish the #134/#91 SLO.
