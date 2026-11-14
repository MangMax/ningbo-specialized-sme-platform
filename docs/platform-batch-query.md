# Asynchronous platform queries


The batch interface reuses the single live-query service in
[platform-live-query.md](./platform-live-query.md). It only persists safe task
parameters and redacted query results in the existing job table. It never writes
roster, identity, platform-evidence or import business tables and adds no migration.

| REST | MCP | Authorization |
|---|---|---|
| POST /api/platform/batches | submit_platform_batch | Existing API/MCP task token |
| GET /api/platform/batches/{batchId} | get_platform_batch | Read-only, no token |
| GET /api/platform/batches/{batchId}/items/{itemId} | get_platform_batch_item | Read-only, no token |
| POST /api/platform/batches/{batchId}/retry | retry_platform_batch | Existing API/MCP task token |

All responses use no-store. Batch task tools are hidden from unauthorized MCP
discovery and protected against raw RPC calls. Input is strict at both the REST
and original MCP RPC boundaries, including nested queries: no Cookie, transport
options, unknown fields, source-incompatible filters or caller-invented itemId.
Generic authenticated POST /api/jobs can also submit kind=platform-query-batch
with the same items/limits params. Prefer the dedicated surface for its batch
receipt and individual-result/retry operations. Existing job cancellation works.

## Submit and read

```json
{
  "items": [
    { "query": { "source": "queryList", "name": "合成企业" } },
    { "query": { "source": "businessList", "uscc": "91330000TEST000001", "rdjb": "all" } },
    { "query": { "source": "queryBusList", "name": "合成企业", "rdjb": ["1", "2", "3"] } }
  ],
  "limits": { "maxRequests": 200, "maxRows": 5000, "maxDurationMs": 120000, "maxResultBytes": 2097152 }
}
```

POST immediately returns HTTP202 `{batchId,itemIds,state}`. IDs are server-created
ULIDs; an itemId belongs only to its batch. Retain the ordered receipt mapping to
input queries and assign one owner per enterprise. Status returns state,
progress `{done,total}`, completeness, attempt, limits, usage, timestamps, error
and items. `done` counts complete items; attempted failures do not advance it.
An item returns `{itemId,status,completeness,segments,unfinished}`. Its status is
success/no_record/auth_failed/failed/partial/not_queried. Each segment has exactly
the single-query result schema: original rows, per-page provenance and outcomes,
original query/completion times, actual conditions, title scope and limits.
Concatenate segments' rows without deduplicating by name/code; each successful
page's fetchedCount identifies its row slice. Failed historical pages remain
visible even after a subsequent segment resolves that range.

Initial item queries preserve the source's public semantics. businessList uses
required string rdjb and continues other titles after ordinary failures;
queryBusList uses array rdjb and stops at the failure with remaining titles
explicit. Auth and safety limits stop further work within that item. Other items
remain independent. Per-title pages and totals are never combined as unique
enterprise counts. An unknown total remains null. No cache or atomic point-in-time
snapshot across pages, items or retries is promised; timestamps show separate
observations, and changing upstream datasets require investigator judgment.

## Explicit retry and interruption

REST retry body is `{itemIds:[…]}`; MCP input also includes batchId. A batch must
be terminal. Unknown, duplicated or already complete item IDs and active batches
are rejected. At most10 executions (initial +9 retries) are allowed. Retry keeps
the same batchId/itemId, completed segments/rows/timestamps, and original
conditions. It queries only each selected item's unfinished title/page ranges
with fixed effective page size, never completed items/pages/titles. Successful
segments and page checkpoints remain stored when another item/page fails.

The existing scheduler remains FIFO and non-OCR jobs exclusive. Batch items run
serially; independently initiated single queries and legacy platform operations
can run alongside them, all through the same process-wide max2 request budget.
The slot includes body reading, legacy retries and retry backoff. Batches do not
create another limiter or direct transport. Parallel deployment processes would
require an external shared limiter; current guarantees cover one Nitro process.

Queued/running jobs are marked failed by existing startup reconciliation, with
safe completed-page checkpoints retained. No credential snapshot survives the
process and there is no automatic resume. An explicit authenticated retry uses
persisted unfinished ranges and a fresh submission-time snapshot. Pages whose
successful response was never checkpointed remain unfinished and must be queried
again; their outcome was not established to the caller.

A retry that ends without producing a new result — the execution threw, was
cancelled while still queued, or the kind is not wired up — keeps the previously
checkpointed `result` and `progress` as they were and only records the terminal
state and error. `finishJob` therefore omits the `result` column when the caller
gives no result, and only an explicit `result: null` clears it. A handler that
does run still owns its own output: `runBatch` re-applies its prior checkpoint
and `persist()`s an incremented `attempt` before any platform request, so an
execution that starts always writes a new result and the count reaches the
ten-execution ceiling. Completed items, completed pages and unfinished positions
never regress because an execution failed.

An `auth_failed`, `safety_limit` or `queryBusList` stop is part of that
execution's output: `runPlatformLiveQuery` returns the segment containing the
failing page and `runBatch` admits it (usage, unfinished positions, `persist()`)
before breaking, so the evidence is checkpointed rather than dropped.

If the retry cannot capture its dependencies at all it fails in `prepare` before
`reopenJob`: the job is not reopened and the request is rejected with a retryable
error, so the previous terminal state and result stay in place. The platform
`prepare` itself does not turn credential-storage errors into that rejection — it
degrades the snapshot to an empty cookie (every page then records
`credential_unavailable`) and only throws (400) for conditions that would echo a
credential.

## Bounds

- Items:1–50, max10 executions per batch.
- Requests:1–200 per execution (default200), including failed requests. Each
  item's retry traversal is additionally bounded by its maxRequests≤100.
- Time:1–120000ms per execution (default120000), starting when the scheduled
  handler begins. Queue wait is separate and visible in job timestamps. Each
  item traversal also respects maxDurationMs≤60000 and global-budget queue wait counts
  toward that segment deadline. Use existing job cancellation if queued work is
  no longer wanted.
- Retained rows:1–5000 per batch (default5000), cumulative across retries. Whole
  pages only; the effective initial page size is min(requested size,item row
  limit) and is fixed on continuation. Insufficient room
  for that page size leaves the range unfinished instead of shifting boundaries.
- Retained result JSON:65536–8388608 UTF-8 bytes (default2097152). Space is reserved
  for page outcomes and batch envelope; an overflowing page is not admitted,
  completed pages stay intact, and the page remains unfinished. This bounds the
  retained/public result, not the upstream raw response's transient allocation.

Limits leave partial, never false complete or no_record. Usage.requests resets
per execution; usage.rows counts retained rows across executions. Retained-row
and result ceilings cannot be expanded by retry; a larger investigation needs
separately scoped queries and evidence linking the old and new ranges. No-record
requires every requested range completing with zero rows. A terminal failed job
can still contain successful items. Inspect item completeness and unfinished,
not only job state or percent.

## Credentials and agent workflow

Each submit/retry calls the existing saved-over-env resolver once, before queueing.
The snapshot is held only in the scheduler closure. Settings changes do not alter
that attempt, including mixed sources/titles and pagination. Snapshot values are
never placed in params, checkpoint/result, response, logs or exception text.
Missing credentials produce not_queried; expired auth is not automatically retried.
Operators maintain credentials through existing settings separately from agents.

The ingestion skill's [app-only workflow](../.agents/skills/roster-ingestion-pipeline/references/platform-query.md)
and [runnable examples](../.agents/skills/roster-ingestion-pipeline/examples/README.md)
retain official rows, evidence-based identities, independent public supplements,
independent preflight/write, unique enterprise ownership and max2 investigators.
Live queryBusList maps only to stored recognized_list through explicit unified preflight/commit; see [archival transfer](platform-recognized-evidence.md). Keep every segment and its original times. Collection itself remains read-only.

## Verification boundary

`tests/platform-batch-query.test.ts` covers public REST core/MCP behavior with
synthetic transport and temporary SQLite. `tests/platform-agent-workflow.test.ts`
executes the shipped single/batch/expired/second-page/multiple-relationship
examples over actual HTTP, auditing app routes without reading Cookie. The
production probe exercises the built server and actual MCP SDK separately.
These are reproducible synthetic checks, not live-platform or actual-account
acceptance. No business database or real platform credentials are used.
