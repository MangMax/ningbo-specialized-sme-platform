# Investigate a difference

One agent owns an enterprise across files and titles. Software collects queries and preserves relations; the agent decides the cause and follow-up measure after checking the evidence. Use the orchestration reference for shared concurrency limits and single-writer handoffs.

## Work one case

1. Fix the identity and scope: enterprise ID/code, title, comparison direction, official file/page/row, and the actual latest export version and collection date. Check both old and current names. Keep every official row.
2. Read the announcement's source page. Separate a formal award/review result from an application, draft publication, maintenance record or export snapshot.
3. Query all relevant platform sources and pages through available application API/MCP capabilities. `queryList` is applications, `businessList` is relations, and `queryBusList` is recognized enterprises. Return every relationship. Inspect `GET /api/platform/capabilities` / `get_platform_capabilities`, then use `POST /api/platform/query` / `query_platform` or the batch workflow in [`platform-query.md`](platform-query.md). Routine agents never reveal/read Cookie values or call platform URLs directly. Check completeness and unfinished ranges before using zero-row results.
4. Keep query failure, completed zero rows, partial coverage and business reasons separate. A failed or unparsed response is not zero. A zero at one title/source is not zero across all sources.
5. Research the discrepancy, not just the enterprise name. Open supporting public/company/registry pages where necessary; search snippets propose leads. Record actual fields, their interface semantics and timestamps. When sources conflict, preserve both and explain what remains unknown.
6. Write a case decision: observed facts and source references; the agent's interpretation; remaining uncertainty; proposed reason and measure; current-name/alias or migration fields that the evidence actually establishes. Confirm only the supported facts. `other` requires a specific established cause outside the existing vocabulary; an unfinished investigation uses `needs_review` with a null reason.
7. Preflight and commit explicit decisions through the unified import API/MCP. Confirm changes by reading the case back. Names/aliases, difference reasons and official events are separate writes with separate evidence. Never use the collecting job's output as a confirmed cause or merge instruction.

## User-confirmed pending review (待审核)

Apply this classification only to a batch whose scope and business interpretation the user explicitly confirmed. Check the same enterprise and same title against all three archived interface results: a current `missing_in_miit` difference, historical `终审通过`, and the latest process row by `sqsj` is `sblx=更新` + `cszt=待审核`. Check all same-title rows for a newer contrary record; preserve conflicting evidence for separate adjudication. Software records this explicit decision; it does not infer the cause automatically.

Record `reasonCode=pending_review`, `status=confirmed_reason`, `verificationStatus=confirmed`, and `measureCode=follow_review` (保留正式公布历史并跟进审核). “Confirmed” describes the classification; it does not mean the ongoing application passed. This is separate from `needs_review` (待核实), review failure, designation expiry and platform staleness. An unknown internal root cause does not undo the user's confirmed classification. No additional official/PDF/web proof is required for this authorized branch. Unknown dates or fields stay null.

Retain the official event, original workflow number/type/submission time/status, all three interface references and the user decision. Append a new temporal explanation with a new `recordedAt`; keep prior audit records. Preflight/commit/readback through the unified API. If the deployed contract lacks `pending_review`, prepare the request and report it blocked on deployment; use the supported independent classification once deployed.

Positive example: enterprise 1395, 宁波东海仪表水道有限公司, specialized SME formally awarded in 2023; same-title historical terminal pass, latest businessList `SQ332025061924614`, 更新/待审核 at `2025-06-19 09:29:17`, absent from current export → 待审核 for the user-authorized batch.

Counterexamples requiring their own adjudication: latest review terminal rejection; historical pass without a later pending update; a pass belonging only to another title; three complete interfaces returning zero rows. None satisfies this branch. Do not extend a batch to other statuses or enterprises without explicit scope.

## Full collection and investigation queues

For a full refresh, the coordinator first verifies the deployed API revision, creates a consistent backup and records the actual enterprise inventory through the app query API. Use stable enterprise IDs and confirmed codes in a run manifest outside Git. Query all in-scope enterprises, including those with no current discrepancy; assignment to the investigation queue is a separate step.

Check source capabilities before choosing whole-list pagination or per-enterprise batches. Do not assume an empty filter is allowed. Preserve each batchId/itemId, effective conditions, title/page range, original timestamps, segments and unfinished positions. Follow `platform-query.md` limits and retry only gaps. One writer preflights, commits and reads back each supported evidence batch before marking its rows imported.

After collection, use the app's actual comparison result at the recorded snapshot version to partition enterprise × title cases. No-difference cases need no cause investigation and must not receive invented reasons. A failed/partial query or an old machine-confirmed reason cannot make a case no-difference. Investigate unresolved discrepancies with one enterprise owner across titles; reuse shared evidence rather than repeat completed requests.

`queryBusList` results can be explicitly transferred as independent `recognized_list` through unified preflight/commit, retaining each original batch segment/time and page/row mapping. Read back query/row IDs before declaring import complete. Missing source/conditions/time/terminal proof remains pending; never relabel as `business_list`/`apply_list`. Follow [archival transfer](../../../../docs/platform-recognized-evidence.md). Collection, evidence import and agent adjudication each have their own completion counts and blockers.

Each investigator returns enterprise ID, title/direction, evidence references, observations, proposed conclusion/measure, unknown fields and verification status. The coordinator alone commits decisions. If the requested Harness/model cannot start, report the launch failure; do not describe the case as reviewed or silently substitute a different runtime.

## Interpret each field in context

- `cszt` such as “已退回待审核”, “撤回” or “终审不通过” describes that application/workflow record. It does not alone establish loss of a formally announced designation, business deregistration or the cause of an export discrepancy.
- When the formal award exists and the recognized list/export does not, investigate synchronization or an incomplete platform workflow. “平台未更新” can be an agent's supported decision; it is not the default for every unexplained mismatch. A formal withdrawal or contrary official evidence must also be checked when present.
- Compare province with province, city with city and district with district. `szsfmc=浙江省` cannot establish an enterprise is outside Ningbo. A unified code prefix or a city in the company name is not a current location.
- Export registration address, communication address and the recognized list's administrative jurisdiction are distinct facts and may be from different times. Label each source; do not overwrite current jurisdiction with an older registration field.
- Migration direction needs an evidenced origin and destination relative to Ningbo. If the evidence establishes Hangzhou in an older source and Ningbo/Beilun in a current source for the same confirmed subject, investigate moved-in, not moved-out. Retain known origin/title/year/batch; absent fields stay null. Query submission timestamps are not migration dates.
- Multiple `qymc` values are evidence to inspect for a rename. Only an agent/user-confirmed identity chain authorizes a confirmed alias or merge. Preserve all original names even while identity is pending.

## Correct historical machine conclusions

List affected case IDs and the original evidence/rule outside Git. Revisit each case independently; an old automatic `confirmed_reason` is not new confirmation. Append a corrected decision with actual evidence and a new `recordedAt`, retaining the original audit trail. Explain user confirmation when that is the basis. Do not bulk reclassify all “other” entries as stale, all outside addresses as migrations, or all name changes as aliases. This code change does not itself alter existing production decisions.
