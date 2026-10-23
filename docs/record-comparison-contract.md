# Record comparison read contract (#67)

`GET /api/roster/record-comparison` and MCP `list_record_comparison` require explicit `queryIds`, `exportBatchIds` (may be empty), and `officialSourceDocumentIds`. The REST query accepts repeated or comma-separated IDs. `asOf` compares timestamp instants, including offsets, and caps selected sources, decisions, and proof verification times. Date-only source fields are compared at UTC calendar-day granularity. It does not select a latest version or reconstruct past decision states: an edge revised after the cutoff appears only in `historicalDecisionUnavailable[]` with its stable ID/endpoints and no later status, revision, or evidence. Affected events and platform rows remain unresolved. Optional `enterpriseId`, `titleCode`, and `classification` filter visible event rows. `page`/`pageSize` (1–200) are applied after global counts. Unknown, duplicate, or out-of-scope IDs fail with 400. Both read surfaces return the same service result and `no-store`.

Each `rows[]` item is one formal `award`/`review` event with its original event ID, record, evidence locations, classification, selected correspondences, linked platform rows, and independent later processes. For a review, `event.year` is the original award year; `event.decidedYear` is the review conclusion year, which is compared with the process row's application year. `awardBatchLabel` remains the raw source value and is not parsed into an award year. Missing or ambiguous timing remains unresolved. `counts` states its distinct grains. `platformWithoutOfficial.rows[]` preserves every selected unlinked original relation by ID, including pending/null identity, with unresolved qualification unless proof and identity checks succeed. Confirmed later-process rows are excluded from formal missing classification and appear in `laterProcessPlatformRows[]`, including rows without a predecessor event. `coverage[]` exposes archived query status, AND conditions, title/page completion and unfinished scope; raw responses and raw fields are omitted. `currentSourceConsistency.recognizedObservations[]` and `exportObservations[]` preserve each selected original row ID. Equal USCC and title produce `same_uscc_title_observed` with both row locations even when definitive qualification is `not_comparable`. No absent edge is interpreted as absent export.

Main event precedence: a confirmed same-event process status contradiction wins; otherwise sufficient confirmed support is aligned; unresolved fact or source scope remains unresolved. A complete archived query covering the exact event subject/title and no confirmed/candidate historical process or recognized edge yields `official_without_correspondence`. An export-context edge does not count as historical correspondence. A later process never changes the event classification. `platform_without_official` requires a verified complete formal scope proof. Definitive `matched`, `interface_only`, `export_only`, and `field_conflict` require a verified interface/export scope and version equivalence proof. Without that proof the read still returns actual positive row observations, and qualification stays `not_comparable`.

`GET /api/roster/record-comparison/legacy-impact` and MCP `preview_record_correspondence_impact` accept the same source set but reject `proofIds`, because this older impact preview does not consume scope proof. They return paginated `difference_reason.id` and original status/reason/measure/evidence references, possible event categories, source-row candidates, counts before pagination, unresolved events, `dataIssues`, and `modelIssues`. All old rows remain unchanged; candidate edges require explicit review. No SQL writes, collection, or business-cause inference occurs.

## Scope proof registration and qualification (#72)

Raw `source_document` still has no complete title/year/enterprise coverage declaration. `platform_query.collectionEvidence` proves actual AND conditions and completed pages when available; `platform_export_batch` still has only a date/hash and does not by itself prove equal account, region, collection window or platform version. `comparison_scope_proof` records a separate user/agent decision with explicit basis, archived source/file field references, scope and source fingerprint. Its `platformVersion` and freeze file reference are attested evidence, never newly discovered raw platform metadata or a fabricated historical timestamp.

Authenticated `POST /api/roster/comparison-scope-proofs/preflight` and `/commit` (MCP `preflight_comparison_scope_proofs` and `commit_comparison_scope_proofs`) register candidate or confirmed `official_coverage` and `current_source_equivalence` evidence through the shared `import_batch` ledger. `GET /api/roster/comparison-scope-proofs`, `/:id`, `/:id/audit` and authenticated `/batches/:idempotencyKey` have matching MCP tools. The proof content is immutable; candidate, confirmation and revocation are append-only audit revisions. The public comparison REST/MCP input accepts optional `proofIds`, resolves only confirmed, current source-bound rows server-side, and supplies `VerifiedComparisonEvidence` to the read service. Omitted, candidate, revoked, out-of-scope or source-drifted IDs cannot qualify negative coverage or current-source consistency. Existing calls without `proofIds` keep their unknown qualification.

The `recognized_export` correspondence guard accepts valid current-equivalence `proofIds` on its existing preflight/commit request. The proof reader rechecks original query rows, effective conditions, completion pages, original export rows, source document/file hashes, formal row coordinates and the archived freeze file. Drift invalidates qualification while retaining the old decision and audit. Proof confirmation remains an explicit agent/user judgment about the cited source contents; the application validates traceability and source binding, not the truth of an uncited business claim.

## UI source picker

`GET /api/roster/record-comparison/sources?kind=query|export_batch|official_document&page=1&pageSize=50` returns `{rows,total,page,pageSize,counts,selection:'explicit',completeness:'not_implied_by_catalog'}`. Each row has `kind,id,label,subtitle,titleCode,titleName,observedAt,status,selectable`; query rows also show `rdjb`, archived completeness/fullRange and effective AND conditions; export rows show SHA-256, row count, and replacement ID; official rows show document title, number, date, and path. A failed export batch is visible but not selectable. Query rows, including partial/failed, remain selectable so users can inspect actual coverage. IDs map directly to `queryIds`, `exportBatchIds`, and `officialSourceDocumentIds`. The catalog is paginated in stable ID order and does not preselect a version or imply that listed documents cover a title/year completely.

## Scoped reads (#86)

The source catalog additionally accepts `ids` (repeated/CSV positive IDs, at most
500), together with a required `kind`. Pagination, `total` and per-kind `counts`
refer to that ID filter when supplied. Existing calls without `ids` are unchanged.
Bookmarked selections hydrate their labels through this filter rather than walking
the entire catalog. Missing IDs leave the selection intact and the existing name
retry available; the comparison endpoint still validates every selected source.

Comparison reads locate selected query IDs, export batch IDs and document IDs
before reading their rows. They omit unused raw response/relation/export bodies.
`asOf` still compares actual timestamp instants and UTC days for date-only sources;
selected sources outside the cutoff are rejected, never replaced with newer ones.
Stored proof validation retains its full original fingerprint inputs, including
selected raw fields, and its source drift rules. Removing an unused field from a
comparison projection does not remove it from source-bound proof validation.

Global formal event counts and the unresolved events whose official file was not
selected remain part of the existing response. Their small facts are streamed in
stable event-ID order. Only visible rows are constructed; all counts precede page
and classification filters. Selected relation and export observations remain
complete and unpaginated at their original ID grain. Grouped identity lookups
preserve duplicate positive observations and never qualify a match without proof.

### Broad comparison follow-up contract (design only)

The frozen synchronous budget covers at most 100 compared records. Existing
larger requests are neither truncated nor silently changed to a latest source.
No background-job API is implemented in #86. A separate implementation ticket
should introduce an opt-in contract before claiming broad-scope SLO compliance:

- `POST /api/roster/record-comparison/jobs` takes the same explicit source set,
  filters, asOf and proof IDs, plus an idempotency key. Return `202` with a job ID
  and the frozen input hash; never switch an existing GET into a job implicitly.
- `GET /.../jobs/:id` reports `queued|running|completed|failed|cancel_requested|cancelled`,
  phase, completed/total source rows, counters, and a result revision. A result is
  available only after all selected rows and global counts finish. Result pages
  retain original IDs/order/qualifications and share one frozen source revision.
- `POST /.../jobs/:id/cancel` is idempotent. Workers check cancellation between
  bounded chunks, release the read snapshot and temporary output, and never expose
  a partial comparison as a complete result. The UI shows progress and a cancel
  control while retaining the last completed comparison.
- Proof revocation/source drift before publication makes the job stale or failed;
  it cannot publish a definitive match from an obsolete source revision. Define
  snapshot retention, authorization, disk limits and cleanup in that follow-up.

These routes/statuses are a proposed contract, not shipped endpoints or passed
acceptance. Full title-wide proof fingerprinting and very large selected sources
still need their own measured budget; a source-ID count is not a record limit.

HTTP/MCP comparisons use a dedicated read-only connection and one read transaction
per request. Proof resolution, selected source rows and streamed formal facts share
that snapshot. The computation yields between setup and bounded groups of 128
formal events, allowing other requests to run while counts are computed. A later
commit is visible to the next comparison, not mixed into an in-flight result.
The connection and any suspended SQLite iterator are released in `finally`.
Synchronous service callers and legacy preview drain the same computation without
changing their existing return type. No shared result cache is introduced.

Catalog query pages first select IDs from the existing
`platform_query_key_idx` covering index and sort those IDs, then seek only the
requested metadata rows. This avoids walking archive-bearing table leaf pages
for a deep OFFSET. Explicit-ID label hydration uses primary-key seeks. The index
name is an existing schema dependency; #86 adds no schema or migration.

## 正式来源目录（#211）

目录以已存储的经信局 `award` / `review` 事件出处为准，按 **完整原路径** 去重。通知、培育、维护材料不能仅凭文件名进入正式目录。保留原路径、附件/名单段、序号及已记录页码；不从目录年份、文件名或序号推断事件事实。重复序号通过事件和出处行身份区分。

原路径匹配 `source_document` 时沿用最小既有文档 ID 与显示元数据。尚无文档登记的路径使用负的首条 `record_evidence.id` 作为只读来源引用；正负空间分离，引用只用于本目录及 `officialSourceDocumentIds`，不是真实 `source_document` 外键，不能提交为覆盖证明。已有正 ID 的直接对比/覆盖证明读取保持兼容。目录恢复名称和翻页同样支持这类引用。出处被更正/移除后旧引用可能失效，调用方应刷新来源；本票不执行 #34 的出处更正。

这是当前快照中的只读连接，无迁移、自动补录或业务写入。只读引用不承诺公告日期或覆盖范围，缺失值保持为空；设置截止时点时，无法证明公告日期的文件不伪造日期以取得资格。文件 HEAD 复用 GET 的根目录、扩展名及存在性规则，缺失文件显示不可用；非 PDF 与 PDF 页码待核分开显示。只有已记录的 PDF 页码可跳转。

## Scoped business grouping (#246, comparison consumer)

The original observation comparison runs first, without removing or deduplicating
relations. All existing `rows`, event pagination/filters, `counts`, `sourceSet`,
coverage, source qualification/proof IDs, correspondence pointers,
`requiresRevalidation` and `historicalDecisionUnavailable` retain their meaning.
This consumer adds no annual conclusion, business difference reason, new proof,
or confirmation decision.

`businessGroups` is a separate page (`businessPage` default 1,
`businessPageSize` default 25, maximum 200). `total` counts known business groups
plus isolated unknown-identity observations **before this pagination**. Stable order is
minimum original relation ID; versions and observations within a group also use
original relation ID order, never a latest-version assumption. Original event
`page`/`pageSize` and the unpaginated original observation arrays are unchanged.

`businessGroups.scope` explicitly states selected query IDs, normalized cutoff
instant, optional enterprise/title filters, `classificationApplied:false` and
`countsBeforePagination:true`. Only the already selected query/time snapshot is
considered, with enterprise/title applied to original observation fields. Formal
event classification and event pagination do not filter this platform scope.
There is no archive-wide business discovery or claim that the event page contains
all selected businesses. Sources later than `asOf` continue to fail the request,
without substitution. No unselected or future observation/decision is borrowed.

In that same read snapshot, `readPlatformBusinessMetadata` fetches only lightweight
canonical columns for the selected original relation IDs, in batches of at most
400. This adds no full raw/archive/canonicalRawJson reads or identity inference.
The comparison-only pure seam is `groupComparisonBusinessObservations` in
`lib/roster/record-comparison.ts`; its presentation boundary is
`ComparisonBusinessGroups.vue`. Neither shared candidate grouping nor annual
algorithms are changed.

- A resolved record uses canonical `(interface,recordId)` as the outer identity and
  canonical verified `versionId` for nested versions. Same-content duplicate observations
  remain individually traceable; A→B→A is two versions and three observations.
- `not_indexed`, `missing_key` and `conflict` have no known record identity and
  remain separate relation-ID fallback groups. A resolved recordId with
  unverifiable content still belongs to its one business outer group. Each such
  observation appears separately in `unknownObservations`, outside `versions`;
  no shared unknown-version node or version count is created. A business with only
  unverifiable observations is one known record and zero known versions.
  Null IDs never imply equal/different versions. Unknown enterprise remains null.
  Group `groupState` describes identity (`resolved` or a fallback identity state),
  while observation metadata retains its own content/identity states.
- Every nested observation retains its public original relation, own selected
  correspondences (including revision/rules/revalidation), unavailable historical
  decision stubs, own `currentSource` comparison and own `withoutOfficial` result
  (null when that old result does not apply). Proofs/qualifications stay on those
  observations. `linkState=linked|later_process|unlinked` follows the original
  comparison membership, not an added qualification decision. Groups/versions
  report `mixed` linkState when memberships differ and `resultState=mixed` when
  observation membership/qualification/decision summaries differ. No group proof
  or confirmed status is synthesized; one confirmed endpoint does not cover any
  other observation/version. The original source reader remains available for
  each observation and reads its current archived detail.

`businessCounts` covers that entire explicitly declared observation scope before
business pagination: `records` counts known canonical record identities (including
known records with unknown content), `versions` counts only verified content
versions, and `observations` counts all selected/scoped original relations.
`unknownIdentityObservations` counts no-record-ID fallbacks;
`unknownContentObservations` counts known-record observations without a verified
version. `unknownObservations` is their sum. `unknownByState` breaks this sum into
not-indexed, missing-key, conflict and unverifiable-content reasons. These are not
archive-wide counts, event counts or qualified-correspondence counts.

REST/OpenAPI and MCP `list_record_comparison` expose the same new page arguments
and result fields through the existing handler and read snapshot. The UI presents
business groups by default, expands versions into every original observation and
its own results, and uses independent business pagination. Existing formal event
results and other-source evidence remain available below it.
