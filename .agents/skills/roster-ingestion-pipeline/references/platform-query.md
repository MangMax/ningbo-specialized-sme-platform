# Platform investigation through the app

1. Inspect `GET /api/platform/capabilities` or MCP `get_platform_capabilities`.
   Inspect current OpenAPI / tools/list for shapes and authorization. On production,
   OpenAPI is hidden unless explicitly enabled; use MCP discovery there.
2. Assign exactly one investigator to each enterprise (ID or confirmed code),
   shared across files. At most two identity investigators work concurrently.
3. Query the app with source-specific conditions; preserve every source row,
   candidate, title/page, effective filter, queriedAt and completedAt. Public
   subject/registry research proceeds independently to close identity evidence.
4. Check status AND completeness AND unfinished for every required range. A
   failed request, expired session, partial page or not_queried item is not zero.
5. Review candidate identity, then run the independent app preflight/write
   workflow. Querying never imports, merges, renames, backfills codes or creates
   designation events. Preserve all official roster rows even if identity fails.

Server-held platform credentials are outside this workflow. Routine investigation
must not read/reveal Cookie, inspect credential storage or call platform URLs.
An expired session goes to the operator for server-side maintenance; the agent
can then explicitly retry unfinished items through the app. App task tokens only
authorize submit/retry and do not contain platform session data.

## Select the source

| source | Meaning and conditions | Title scope |
|---|---|---|
| queryList | Application records; `name` and/or `uscc`, AND when combined. | Source default, no explicit rdjb. |
| businessList | Relations; requires `uscc`, rejects name and recognized filters. | Required string `rdjb:"all"` or `"1"`, `"2"`, `"3"`. all starts at page1. |
| queryBusList | Recognized-enterprise list; `name` and/or `uscc`, AND. | `rdjb:["1","2","3"]` default; unique nonempty array, never businessList's string. |

Title1=创新型中小企业,2=专精特新中小企业,3=小巨人. All three sources
retain multiple relationships with the same code. Name/keyword hits are candidates.

Only queryBusList accepts these optional restrictions: `sqsj` exact ordered real
calendar dates `YYYY/MM/DD - YYYY/MM/DD` (inclusion/timezone unverified), `rddqrq`
effective year YYYY, `whpcyear` maintenance year YYYY, `whpc` string1–15 requiring
whpcyear, and `szq` account-scoped eight-digit filter code (distinct from returned
row szq). Only paired `orderField:"qymc",orderDirection:"asc"|"desc"` is supported.
Do not add restrictions by default or infer a global account region dictionary.

## Single or batch

Single: `POST /api/platform/query` or MCP `query_platform` with the query object.
Each response states source, effectiveConditions, titleScope, rows, page outcomes,
fetchedCount, nullable declaredTotal, completeness, fullRange and unfinished.
No-record requires every requested range to have completed with zero rows;
fullRange=false only proves the requested continuation. Unknown total stays null.

Batch: `POST /api/platform/batches` with `{items:[{query:…},…],limits?:…}` or MCP
`submit_platform_batch`. Submission/retry require the app API/MCP task token.
Retain receipt batchId and every itemId with its owner. Poll
`GET /api/platform/batches/{batchId}` / `get_platform_batch`; retrieve an item at
`GET /api/platform/batches/{batchId}/items/{itemId}` / `get_platform_batch_item`.
Queued/running means work remains. `progress.done` counts complete items, not
attempted items. Terminal failed may contain successful items and page checkpoints.

Each item contains append-only query `segments` and its current `unfinished`.
Keep all segments, original times, successful pages and their rows; row slices
follow successful pages' fetchedCount. Do not compress by name/code. A retry may
make the item complete while earlier failed-page history remains visible.

## Retry only the gap

After failure review, submit `POST /api/platform/batches/{batchId}/retry` with
`{itemIds:[unfinishedItemId,…]}`, or MCP `retry_platform_batch` with batchId plus
itemIds. IDs remain stable. Completed/unknown items or an active batch are
rejected. Only unfinished title/page positions are queried; original conditions
and page size remain fixed. Existing completed rows and query times remain intact.
Authentication failure is not automatically retried. Each explicit retry captures
a new server-side submission snapshot; settings changes never alter an in-flight
attempt. A service restart marks queued/running jobs failed, retains checkpoints,
and requires this explicit retry; it never falsely claims automatic recovery.

Single-query manual continuation uses the returned page size and each unfinished
position: startPage=page; businessList rdjb=position.rdjb string, queryBusList
rdjb=[position.rdjb]. Never rerun all titles when some are already complete.
BusinessList ordinary failures continue other titles, but auth and safety stop;
queryBusList failures stop and retain all unqueried titles. Batch initial queries
reuse these exact policies.

## Bounds and evidence

Max50 items,10 attempts; each execution max200 requests/120seconds, each item
traversal remains within its single-query bounds (100 requests/60seconds).
Retained batch rows max5000 and result bytes max8MiB (default2MiB). Caps leave
partial with explicit gaps; they do not prove no-record. Queue wait is separate
from execution time. Retained-result/row ceilings cannot be expanded by retry;
use a separately scoped query and retain the old evidence if a result cannot fit.
All platform traffic shares the app's single-process max2, including single,
legacy and backoff. Do not start per-worker direct request pools. Multi-instance
coordination is not provided by this in-memory limiter.

Stored evidence supports business_list, apply_list and independent recognized_list
(queryBusList only). Explicitly transfer each complete original result/each batch
segment through unified preflight/commit using recognizedResultToImport; preserve
original times, conditions, pages and raw rows. Missing metadata or terminal proof
remains pending; never relabel or invent completeness. Read back history with
GET /api/platform/queries or list_platform_queries and reconcile every query/row ID.
See [archival transfer](../../../../docs/platform-recognized-evidence.md). See
[`uscc-recovery.md`](./uscc-recovery.md) for independent public supplements and the
current cross_source gate. Run credential-free examples and behavioral verification
from [`../examples/README.md`](../examples/README.md). Full API details:
[`docs/platform-batch-query.md`](../../../../docs/platform-batch-query.md).
