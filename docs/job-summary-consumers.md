# Task summary consumers (#134 M2)

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


At the M2 baseline (`59462b101b93b530740b4ce3b4bb108288e3b6b5`), the repository has two executable generic job-read consumers:

- `scripts/reconcile-live.mjs --base-url`: submits the existing reconcile job, polls `GET /api/jobs/:id?view=summary`, then reads `GET /api/jobs/:id` at a terminal state. The full detail is authoritative for state, error and result. If a domain retry reopens the same ID between reads, polling continues. Failed/cancelled partial receipts still go to `--out` and exit nonzero. Submission authorization, local execution, polling interval and runner ownership are unchanged.
- `scripts/perf-82/run.mjs`, scenario `jobs`: requests `GET /api/jobs?view=summary&limit=25`. `pageSize` is not the jobs route's limit parameter. The scenario measures the summary list without hydrating each row. Historical measurements using the old full-list request must remain labeled as such.

The fixed incoming main (`a9bc61f79104a0ccbadf1a7b0a3258efd4f8327f`) adds `/tasks`. Its delivered consumer uses the domain summary endpoints `GET /api/task-center` and `GET /api/task-center/:id`, rather than generic full job reads. Keep that bounded whitelist projection: list polling does not hydrate params, raw result, platform segments/rows or OCR text. Selected task details load bounded items/result links separately. See [task-center.md](task-center.md). The generic CLI consumers above retain explicit `view=summary` polling and lazy full result consumption.

## Task-center and generic summary seams after fixed-main integration

- `/tasks` polls its existing domain list/detail via `useTaskPolling`, retains its URL/pagination/return behavior and authorization-dependent capabilities. This is the incoming #120/#121 consumer, not a new generic-jobs UI migration. No consumer rewrite is required by #134.
- Generic list and ID polling use `JobSummaryDto` from `lib/job.ts`, `view=summary` and `limit<=50`. Summary does not load params/result/error bodies or credentials. Current-roster export `percent` is nullable while the total is unknown, matching main's full DTO; SQLite projects only a boolean indicating whether the active export phase is workbook. Done exports report 100.
- Generic `detailUrl` loads full results lazily, with complete non-sensitive receipts, OCR page order and platform segments retained. Full export reads refresh artifact availability through the existing artifact authority, then apply output redaction. `resultSummary.available` includes running and failed/cancelled checkpoints; it does not prove success or completeness.
- Generic `capabilities.cancel` is eligibility only. The authenticated DELETE remains authoritative. Task-center capabilities additionally depend on API or explicitly scoped same-origin browser authorization. A summary selector grants no mutation or artifact-download authorization. Keep main's deployment switch and origin rules unchanged.
- The CLI re-reads full detail state when concurrent domain retry can reopen an ID. Current-roster exports retain main's explicit regeneration flow, not generic retry.
- Desktop/390px task-center interactions are inherited incoming UI behavior; this integration edits no Vue code and makes no fresh browser claim. Combined-source browser acceptance belongs to the parent.

## Verification boundary

CLI regressions execute the real child process against a loopback HTTP fixture with synthetic receipts. They prove summary polling and lazy result/error consumption, not production timing, queue execution or storage cost. Those CLI regressions do not validate task-center UI interaction. This compatibility integration preserves incoming migrations and task UI; it changes only the necessary read composition and focused regressions.

The performance runner must use an isolated verified terminal-only snapshot before its first jobs request: the unchanged runner startup may attempt recovery writes for queued/running tasks. Retrying a failed first read on a readonly pending snapshot is not valid acceptance. Parent acceptance must bind the final combined SHA to real SQLite/public HTTP measurements, response size, deep history/result growth, heap/RSS and 1/2/5 concurrency latency. Targeted tests do not establish the #134/#91 SLO.
