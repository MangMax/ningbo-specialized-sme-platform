# Investigate a difference

One agent owns an enterprise across files and titles. Software collects queries and preserves relations; the agent decides the cause and follow-up measure after checking the evidence. Use the orchestration reference for shared concurrency limits and single-writer handoffs.

## Work one case

1. Fix the identity and scope: enterprise ID/code, title, comparison direction, official file/page/row, and the actual latest export version and collection date. Check both old and current names. Keep every official row.
2. Read the announcement's source page. Separate a formal award/review result from an application, draft publication, maintenance record or export snapshot.
3. Query all relevant platform sources and pages through available application API/MCP capabilities. `queryList` is applications, `businessList` is relations, and `queryBusList` is recognized enterprises. Return every relationship. Check the live contract first; if a source is not exposed, record the capability gap and obtain evidence through an explicitly authorized research route. Routine agents never reveal/read Cookie values. See the identity reference and issues #51–#54 for current interface delivery boundaries.
4. Keep query failure, completed zero rows, partial coverage and business reasons separate. A failed or unparsed response is not zero. A zero at one title/source is not zero across all sources.
5. Research the discrepancy, not just the enterprise name. Open supporting public/company/registry pages where necessary; search snippets propose leads. Record actual fields, their interface semantics and timestamps. When sources conflict, preserve both and explain what remains unknown.
6. Write a case decision: observed facts and source references; the agent's interpretation; remaining uncertainty; proposed reason and measure; current-name/alias or migration fields that the evidence actually establishes. Confirm only the supported facts. `other` requires a specific established cause outside the existing vocabulary; an unfinished investigation uses `needs_review` with a null reason.
7. Preflight and commit explicit decisions through the unified import API/MCP. Confirm changes by reading the case back. Names/aliases, difference reasons and official events are separate writes with separate evidence. Never use the collecting job's output as a confirmed cause or merge instruction.

## Interpret each field in context

- `cszt` such as “已退回待审核”, “撤回” or “终审不通过” describes that application/workflow record. It does not alone establish loss of a formally announced designation, business deregistration or the cause of an export discrepancy.
- When the formal award exists and the recognized list/export does not, investigate synchronization or an incomplete platform workflow. “平台未更新” can be an agent's supported decision; it is not the default for every unexplained mismatch. A formal withdrawal or contrary official evidence must also be checked when present.
- Compare province with province, city with city and district with district. `szsfmc=浙江省` cannot establish an enterprise is outside Ningbo. A unified code prefix or a city in the company name is not a current location.
- Export registration address, communication address and the recognized list's administrative jurisdiction are distinct facts and may be from different times. Label each source; do not overwrite current jurisdiction with an older registration field.
- Migration direction needs an evidenced origin and destination relative to Ningbo. If the evidence establishes Hangzhou in an older source and Ningbo/Beilun in a current source for the same confirmed subject, investigate moved-in, not moved-out. Retain known origin/title/year/batch; absent fields stay null. Query submission timestamps are not migration dates.
- Multiple `qymc` values are evidence to inspect for a rename. Only an agent/user-confirmed identity chain authorizes a confirmed alias or merge. Preserve all original names even while identity is pending.

## Correct historical machine conclusions

List affected case IDs and the original evidence/rule outside Git. Revisit each case independently; an old automatic `confirmed_reason` is not new confirmation. Append a corrected decision with actual evidence and a new `recordedAt`, retaining the original audit trail. Explain user confirmation when that is the basis. Do not bulk reclassify all “other” entries as stale, all outside addresses as migrations, or all name changes as aliases. This code change does not itself alter existing production decisions.
