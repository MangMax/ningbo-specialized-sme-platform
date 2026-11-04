# 单事件年度过程只读契约（#250）

`lib/roster/annual-process.ts` 是唯一纯规则接缝：

```ts
buildAnnualProcess(input: AnnualProcessInput): EventAnnualProcess
// input: { event: AnnualProcessEvent, groups: PlatformBusinessGroup[], coverage: AnnualProcessCoverage[] }
readEventAnnualProcess(db, eventId): EventAnnualProcessRead | null
// server/utils/event-annual-process-read.ts: { process, sourceGeneration, sourceRefs }，完整步骤不分页
```

`AnnualProcessEvent` 沿用 EventSource 的 id/eventType/year/decidedYear/reviewOutcome 及 record.enterpriseId/titleCode/usccRaw。award 使用 year + apply；review 使用 decidedYear + review，缺结论年不退回原认定年。末态仅认定 `终审通过`、`终审不通过` 为终态；未知原状态保留。

`process` 提供 businessYear、declareKind、steps、latestStepId、latestStepSummary、finalCandidateStepId、reasons、coverage、coverageReasons、excludedIdentityRelationIds。steps 全部真实年内过程，包含失败/退回；排序字段 appliedAt 是**申报时间**。年内最晚申报业务的最新观察决定末态；不回找早期通过。缺失业务年/事项/申报时间、真实冲突或同时间不明不能按行ID打破歧义。

每 step 的 id 仅是本次已归档范围内逻辑步标识，包含各接口独立 record 身份；businessKey/year/declareKind/appliedAt/status/observedAt/annualEligible/reasons 是该步事实。groups 原样保留各接口 record/version、representativeRelationId、observationRefs（relationId/queryId/sequenceNo/interface/queriedAt/target/evidence）和每个观察实际 existingCorrespondences，不传播 proof/决定。原行可用已有 SourceReader relation 端点读取。representative **不等于最新观察**。latestObservationRelationIds 与 latestVersionRefs 指明每个独立接口/record的最新且与逻辑末态同态、无真冲突的版本出处；preferredWriteRelationId 仅指其中最新且查询称号或native rdjb明确的 business_list 行，不保证可写或已确认。corroborationRefs 给出 field/fromRelationIds/toRelationIds；仅同USCC/业务ID及稳定事实一致时补缺字段，不合并接口持久化record。

`finalCandidateStepId` 只表示**当前已归档限定范围**的事实资格，不表示来源已重新核验、对应已确认或最终标记已落地。可选 `finalQualification:{stepId,status:'confirmed'|'eligible'|'blocked'|'none',decisionRefs,reasons}` 由 #251 当前源/对应资格读侧提供；GET 不调用 preflight。任务 submit/get/cancel/retry 属于 #251。

coverage 保留原 query 状态及 range 证明，legacy 缺 metadata 是 archive_range_unknown，不声称上游完整，也不因此阻止确定年度事实。最新已知 partial/failed/range incomplete 阻止 final；旧失败不冒充查询成功。

`sourceGeneration` 是 sourceRefs 稳定 JSON 的 SHA256，排除所有对应决定及决定冲突。sourceRefs 包含 scope（owner/title/业务年/事项/规则版本）、正式事件 revision 与字段、全部正式 evidence 与文件 hash/removedAt、完整限定观察集合（queryId/relationId/interface/recordId/versionId/sourceFingerprint）与覆盖 metadata。每观察 sourceFingerprint 包含时间/身份/接口/称号/target、规范七字段 facts 与真冲突、业务 metadata/contentHash/版本/来源；写对应自身不改变代次。正式来源、观察集合/版本/资格事实改变会改变代次。hash 不替代写侧 protected preflight 的独立 provenance/sourceFingerprint 验证。

读取先经索引限定事件 owner/query/title，再按已限定 relation IDs 调用来源专用事实 seam（`readPlatformObservationFacts`）：apply/business/recognized 各自读取 typed 投影；未投影的历史观察回退既有规范。消费者不读取各投影表布局，也不新增三接口通用字段 adapter。规范后限定事项；无native称号的queryList仅由唯一明确business_list称号种子、同规范USCC/平台key/稳定事实建立年度title lineage后调用共享 readPlatformBusinessGroups。不加载大 raw、raw_response、collectionEvidence.rows；无全库 scanallquery/JS array-in。纯身份取证转写须具有明确来源且无业务ID/事项/申报时间/状态才排除；未知空业务保留为缺口。该函数不写投影/ledger、不联网。

#320 起，候选与默认年度事实共用 `lib/platform/observation-facts.ts` 的 observation fact 契约与 `server/utils/platform-source-facts.ts` 的按来源分发；typed 投影优先，未投影历史行保留 legacy fallback。显式 comparison admission 为保持其冻结 SQL/payload 预算，继续使用已限定行的 legacy 投影；默认年度读取使用该 seam。候选 `year_mismatch` 显式使用比较年：award 用原认定年，review 用 `decided_year`；recognized 维护年不参与年度过程比较。复核缺结论年保留 `official_decision_year_missing`，不误报 `year_mismatch`。

公开协议：GET `/api/roster/events/:id/annual-process?page=1&pageSize=50`，MCP `get_event_annual_process {eventId,page?,pageSize?}`，同一应用 adapter。仅接受正安全整数，pageSize <=200；REST拒绝 asOf/sourceSet 等未知参数；MCP输入shape不公布、不解释这些参数（沿用toolkit处理）。响应 `{process,sourceGeneration,sourceRefs,total,page,pageSize}`；仅 `process.steps` 在资格计算完成后分页。latest/final ID 可指向当前页以外的步骤。所有步骤及来源的完整重算由内部读取函数完成；sourceRefs 是完整集合，展示分页不是资格范围。找不到正式award/review返回404，坏参数400，非GET405，内部失败500且不泄露异常。

latestStepSummary 是完整scope中 latestStepId 对应步骤的窄摘要（id/year/declareKind/appliedAt/status/observedAt），无latest时null；摘要与本次response同sourceGeneration，不因steps展示分页而截掉，不需跨请求读取末页。

年度title lineage保留原queryTitleCode=null，在ref.evidence.title中列出donor原关系ID；year仍只取同业务明确字段，并在corroborationRefs给出逐字段from/to关系ID。小范围owner的titleScopeRefs metadata进入sourceRefs/generation，检测同key双明确title，不能跨title互证。接口record身份仍各自独立。不修改旧sourceForEdge/candidate/proof口径。

无法证明title的潜在业务进入process.scopeGaps（relationId/queryId/interface/year/declareKind/appliedAt/reasons），其原facts指纹也进入完整sourceRefs；可能改变末态时阻止final，不能把它丢弃后选旧pass。显式其他年可在同业务互证完成后排除；明确更早的缺口仍如实显示，不凭空使其成为较晚竞争业务。全部限定来源及donor都在generation内，非仅当前显示受体。
