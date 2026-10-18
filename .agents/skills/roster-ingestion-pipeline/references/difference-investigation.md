# Investigate a difference

One agent owns an enterprise across files and titles. Software collects queries and preserves relations; the agent decides whether records disagree, then the cause and follow-up measure. Use the orchestration reference for ownership and handoffs. For this workflow, business judgement uses Magpie + DeepSeek Open Design when that is the user's selected runtime; code/deployment/writing agents execute confirmed decisions rather than replacing the judge.

## Work one case

1. Fix the identity, title and requested batch. Record the actual export version/date, query scope/time, and every relevant formal event's source file/attachment/list number. Keep all official rows and original names.
2. Reuse stored queries, complete archives, confirmed aliases and already verified source evidence. Separate formal award/review results from applications, drafts and maintenance. File ingestion still requires the page verification in `workflow.md`; a later judgement need not repeat it. When the user limits the task to existing evidence or three interfaces, stay in that scope. Record a specific remaining gap instead of adding PDF/web research or new platform queries automatically.
3. Collect missing evidence only when in scope, through app REST/MCP. `queryList` is applications, `businessList` is relations, and `queryBusList` is recognized enterprises. Inspect capabilities and follow [`platform-query.md`](platform-query.md). Return every relationship, original time and page; never read Cookie or call platform URLs directly. Distinguish complete zero rows from partial/failed/unparsed results.
4. Align the formal event and platform records using the procedure below. Do this in the case report even while product-level relationship persistence is not implemented; that implementation is tracked in issue #63 and does not block manual adjudication.
5. Decide whether there is a real discrepancy before assigning a reason. Use the decision table; preserve later workflow states separately from the historical agreement. Identity, title, year/batch and record type ambiguities need an explicit explanation, not the latest row as a substitute.
6. Write the observation, corresponding records, decision and evidence references; list only the facts still missing. `other` requires a specific established cause, not an unfinished investigation. Put unresolved record identity, source absence or contradictory jurisdiction under the single user-facing category 待人工审查 with its concrete question.
7. Hand off confirmed decisions within the user's write authorization. Reporting-only work stops at the report. The single writer checks the live contract, preflights, commits and reads back through unified REST/MCP. Names/aliases, reasons and formal events have separate evidence and writes. Never use collection output or a script's field mapping as an agent decision.

## Compare corresponding records

The comparison unit is a formal event and its corresponding platform business records, not an enterprise's entire designation history against its latest export membership.

- Confirm the subject and title; identify original recognition year/batch, award versus review result and conclusion year. Match the platform business number/recognition identifier, title, year/batch and workflow type where supported. Submission time, original recognition year and review conclusion year are different facts.
- Inspect all application and relation rows, not just `queryBusList` or the newest timestamp. A history of award, review failure, resubmission and update can contain several valid facts; preserve each. Different titles never cancel one another.
- Mark each link as established, a candidate or unsupported, with the actual row reference. A successful query is not proof that every returned row supports the event. Missing metadata stays empty; do not invent year/batch equivalence.
- Export tables represent the recognized-enterprise list at the export time and effective scope. Record those alongside the later interface query. Check original rows, title, conditions and version before interpreting an apparent mismatch; the export is not an independent authority with a separate business history.
- Read Excel headers rather than assuming the same USCC column in all three workbooks. Some worksheets advertise an incorrect `A1` dimension; ensure a full read (for example, reset dimensions when using openpyxl read-only mode). Match the same title by confirmed code and inspect evidenced names; another title's hit does not settle the comparison. Keep actual Excel row references and avoid logging unrelated contact fields.

## Business decisions after alignment

| Observed records | Decision and boundary |
|---|---|
| Historical formal recognition matches the platform record; later pending/returned/review activity is consistent and no contrary formal result is identified. | 无差异. Keep the historical recognition and later workflow verbatim. Current export absence or absence of a new annual announcement alone does not create a difference or prove title expiry. |
| A formal award/review result is published, but its corresponding same-title/year/batch platform process has not reflected it. | 平台未更新. Record the actual lagging process; do not require knowledge of the platform's internal mechanism. A historical event already matched by a historical platform pass is not automatically in this category. |
| A corresponding formal result and a newer recognition/process are present, while the recorded export has not reflected that result, and the user confirms this as 未更新. | 平台未更新 under that confirmed interpretation. Keep the exact process state, recognition row and snapshot/query times; do not invent a synchronization mechanism or classify all interface/export mismatches this way. An original-row hit instead means the earlier missing-export observation was wrong. |
| Every requested interface/title range completed with zero rows. | 无记录. State whether this is the whole enterprise or only the title. Preserve formal history; zero rows do not prove deregistration, migration or expiry. Failures and unfinished ranges remain query gaps. |
| Evidence establishes old/current names or origin/destination for the same subject. | 更名、迁入 or 迁出 as supported. Reuse established evidence; do not demand a new public search because a report omitted it. Missing migration date, original title/year/batch or other supplementary fields stays null rather than blocking the established fact. |
| Platform review passed, but no corresponding formal review publication is found in the sources examined. | 待人工审查: name the review year/batch, old/current names checked and missing source. Do not turn it into 无差异 solely because a prior award was published. A confirmed rename and an unresolved review-publication gap may coexist. |
| A platform recognition exists, but its corresponding formal source is missing; subject, jurisdiction or record mapping genuinely conflicts. | 待人工审查: state the exact missing or conflicting fact. Use this same label for what older reports called 事实不足 or 数据匹配需核对; keep the useful subtype in the explanation. |

Workflow status is not a difference reason by itself. Pending, returned and rejected rows must first be placed in their corresponding history. Keep review failure and later resubmission distinct; do not infer revocation or expiry solely from a return, absent current row or absent new announcement.

## User-confirmed pending review (待审核)

Apply 待审核 as a difference classification only to a batch whose scope and interpretation the user explicitly confirmed, after record alignment. Historical `终审通过` plus a latest `sblx=更新` / `cszt=待审核` and current export absence describe a workflow; these fields alone are not an automatic reason rule. If the historical event and subsequent process agree under the user's record-aligned interpretation, report 无差异 and retain 待审核 as the process state. Do not automatically relabel or rewrite an earlier user-authorized batch when the interpretation changes; review its cases with an audit-preserving preview.

For an explicitly confirmed 待审核 decision, inspect all same-title records for contrary terminal results, including an earlier review rejection followed by a later update. Different business types do not override each other by timestamp: 更新/待审核 cannot reverse 复核/终审不通过. Preserve those facts together for agent/user adjudication rather than admitting the case to a pending-review batch automatically.

Record `reasonCode=pending_review`, `status=confirmed_reason`, `verificationStatus=confirmed`, and `measureCode=follow_review` (保留正式公布历史并跟进审核). “Confirmed” describes the classification; it does not mean the ongoing application passed. This is separate from `needs_review` (待核实), review failure, designation expiry and platform staleness. An unknown internal root cause does not undo the user's confirmed classification. No additional official/PDF/web proof is required for this authorized branch. Unknown dates or fields stay null.

Retain the official event, original workflow number/type/submission time/status, all three interface references and the user decision. Append a new temporal explanation with a new `recordedAt`; keep prior audit records. Preflight/commit/readback through the unified API. If the deployed contract lacks `pending_review`, prepare the request and report it blocked on deployment; use the supported independent classification once deployed.

See the [synthetic decision walkthroughs](adjudication-examples.md) for no-difference, pending-review, rejection and source-gap examples. Do not extend an authorized batch to other statuses or enterprises without explicit scope.

## Full collection and investigation queues

For a full refresh, the coordinator first verifies the deployed API revision, creates a consistent backup and records the actual enterprise inventory through the app query API. Use stable enterprise IDs and confirmed codes in a run manifest outside Git. Query all in-scope enterprises, including those with no current discrepancy; assignment to the investigation queue is a separate step.

Check source capabilities before choosing whole-list pagination or per-enterprise batches. Do not assume an empty filter is allowed. Preserve each batchId/itemId, effective conditions, title/page range, original timestamps, segments and unfinished positions. Follow `platform-query.md` limits and retry only gaps. One writer preflights, commits and reads back each supported evidence batch before marking its rows imported.

After collection, freeze the app's actual comparison result and snapshot version as the candidate queue. Until record-level comparison is implemented, its historical membership difference is not an adjudicated business discrepancy. Align the relevant events and platform rows before partitioning no-difference and investigation cases. No-difference cases need no invented cause; failed/partial evidence or an old machine reason is not confirmation. Reuse evidence with one enterprise owner across titles.

`queryBusList` results can be explicitly transferred as independent `recognized_list` through unified preflight/commit, retaining each original batch segment/time and page/row mapping. Read back query/row IDs before declaring import complete. Missing source/conditions/time/terminal proof remains pending; never relabel as `business_list`/`apply_list`. Follow [archival transfer](../../../../docs/platform-recognized-evidence.md). Collection, evidence import and agent adjudication each have their own completion counts and blockers.

Each investigator returns enterprise ID, title, aligned event/workflow references, observed states, proposed conclusion/measure, unknown fields and verification status. A user-facing report uses Chinese business categories and actual record text, not internal enum names. Report enterprise counts separately from title/event items, explain overlap and keep group boundaries stable. Use 待人工审查 consistently, listing concrete subtypes instead of scattering unresolved cases across opaque labels. The coordinator alone commits decisions. If the requested Harness/model cannot start, report the launch failure; do not describe the case as reviewed or silently substitute a different runtime.

## Interpret each field in context

- `cszt` such as “已退回待审核”, “撤回” or “终审不通过” describes that application/workflow record. It does not alone establish loss of a formally announced designation, business deregistration or the cause of an export discrepancy.
- Apply the decision table after aligning records. Formal publications establish designation events; platform queries establish what each interface returned at that time. Neither a current absence nor a pending workflow alone determines the whole designation history.
- Compare province with province, city with city and district with district. `szsfmc=浙江省` cannot establish an enterprise is outside Ningbo. A unified code prefix or a city in the company name is not a current location.
- Export registration address, communication address and the recognized list's administrative jurisdiction are distinct facts and may be from different times. Label each source; do not overwrite current jurisdiction with an older registration field.
- Migration direction needs an evidenced origin and destination relative to Ningbo. If the evidence establishes Hangzhou in an older source and Ningbo/Beilun in a current source for the same confirmed subject, investigate moved-in, not moved-out. Retain known origin/title/year/batch; absent fields stay null. Query submission timestamps are not migration dates.
- Multiple `qymc` values are evidence to inspect for a rename. Only an agent/user-confirmed identity chain authorizes a confirmed alias or merge. Preserve all original names even while identity is pending.

## Correct historical machine conclusions

List affected case IDs and the original evidence/rule outside Git. Revisit each case independently; an old automatic `confirmed_reason` is not new confirmation. Append a corrected decision with actual evidence and a new `recordedAt`, retaining the original audit trail. Explain user confirmation when that is the basis. Do not bulk reclassify all “other” entries as stale, all outside addresses as migrations, or all name changes as aliases. This code change does not itself alter existing production decisions.
