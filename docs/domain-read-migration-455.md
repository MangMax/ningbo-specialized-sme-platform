# 平台分域读模型消费者迁移登记（#455 slice 1）

状态：**登记基线，不是 fresh PASS**。本文件只盘点「谁仍在读旧路径」并给出 14 组状态、承载票与回退边界；不修改生产代码、数据库、页面或导出规则。

- 基线：`t3/455-registry` @ `81a50de0`（集成分支 `t3/implement-spec-455` 当时 tip，0/0）。
- 上级：issue #455（scope:L）、#296、ADR `docs/adr/0001-source-domain-boundaries.md` §6/§7。
- 行号与结论均为该基线的静态代码检索结果；后续提交需重新核对。
- 「登记」不等于「已在隔离真实数据上对照通过」，也不等于 UI 桌面/390px、异步导出或性能已验收。所有未运行项见 §7。

## 0. 登记口径

| 状态 | 含义 | 最低证据 |
|---|---|---|
| **已切换** | 该组消费者当前实际执行的是新领域接缝/来源专用读；旧 reader 仍保留且可显式回退。 | 代码入口 + 已合入票/提交 + 至少一条同输入对照或既有回归测试。 |
| **由某票承载** | 已有票（或 #455 明确切片）承担切换，当前仍读旧路径。 | 票号/切片 + 当前状态 + 阻塞项；不得把「已开票」写成「已切换」。 |
| **本阶段不切** | 本阶段明确不切换。 | 收益/风险/依赖理由 + 旧调用清单 + 旧调用仍可读的边界。 |

三条硬规则：

1. 每组必须有 owner 与稳定接缝，不能只写「平台层」。
2. 旧调用必须写到文件 + 函数/端点/页面/任务/导出/技能，不能只写表名。
3. 已切换组必须写清旧 reader 保留与回退触发条件；「本阶段不切」组必须写清旧调用仍可读到什么、不能读到什么。

## 1. 14 组总表

| # | 影响组 | 状态 | 承载票 / 理由 | 当前实际主读路径 | 旧 reader / 回退 |
|---|---|---|---|---|---|
| 1 | 平台三业务（入口/归档/详情/本地业务查询） | **由 #455 slice 2 承载（待开票；本地三来源查询已切）** | #455 slice 2；#453/#458/#462 已合入 | 企业列表/详情/比对/差异仍读 `platform_query`/`platform_relation`；本地三来源查询读各自 typed 投影 | `queries/relations/businessRecords` 原字段保留；旧 reader 不删 |
| 2 | 来源与采集（封套/身份版本观察/单查批查/历史投影/原档核对/分页/重放） | **本阶段不切（原始封套/原档接缝）** | 无切换票；#298/#299/#300 是修复且已关闭 | `platform_query`/`platform_relation`/raw、`platform_export_*`；身份/版本/观察仅作共享元数据 | 全部原 query/relation/export ID、raw、分页、重放回执可读 |
| 3 | 正式公布（原值/事件/导入追加/更正归并/历史详情导出） | **由 #303 承载（部分已切）** | #303 OPEN；#355/#356 已合入 | 详情/正式来源/当前查询/当前工作簿读 `official_evidence_row_revision`；旧同步导出/台账仍读 `record/event/evidence` | 旧 record/event/evidence 字段与深链保留；新投影 additive |
| 4 | 企业主体（资料/断言维护/迁移事实/维护页/差异/资格/技能） | **由 #306/#307 承载（未开始）** | #306、#307 OPEN | `difference_reason` 的 `moved_in/moved_out/deregistered` 与 `moved_in_*` 列；资料/别名走既有 PATCH | 旧 head、movedIn 列、审计与别名 ID 保留 |
| 5 | 对应与年度（候选/确认/驳回/解除/全过程/final/proof） | **已切换（#320）** | #320 CLOSED，合入 `81a50de0` | `readPlatformObservationFacts` → 三来源 typed 读；未投影历史走 bounded legacy fallback | `useSourceFacts=false` 对照入口 + 旧 relation 原值保留 |
| 6 | 当前资格与导出（周期/优质中小企业 HTTP/MCP/页面/三称号工作簿） | **由 #468 承载（未切）** | #468 OPEN | `platform_relation.raw_fields` + `platform_query.collection_evidence` 的 `json_extract` | 旧 current reader、响应版本、规则版本、导出列全部保留 |
| 7 | 文件内容（内容/依赖/恢复/上传页/预览/出处/备份恢复） | **由 #311/#312 承载（未开始）** | #311、#312 OPEN | `stored_file`/`stored_file_part`/路径字符串；软移出 + `deleteDisk=1` | 旧 file ID/path/bytes/sha256 可读；物理删除字节不可恢复是 #312 缺口 |
| 8 | OCR与解析（采集/校对/解析各拥有输入输出版本） | **已切换（#308/#309/#310）** | 三票 CLOSED | `ocr_result` 页版本（`id:revision`）+ 解析 `inputRef`/`expectedVersion` | 旧解析输入依据 unknown；旧读取接口与载荷保留 |
| 9 | 后台任务（runner 外壳 + 各 kind 本义摘要） | **由 #314 承载（未开始）** | #314 OPEN；#313 已 CLOSED | `job.params/result/progress` JSON + `task-center-http.ts` 的 `json_extract` 投影 | 旧 job 行、取消/重试、历史 checkpoint 保留 |
| 10 | HTTP与MCP（共享领域命令/校验/schema/鉴权/公开读回） | **由 #315 承载（未开始）** | #315 OPEN；#298 已 CLOSED | 各 route meta + MCP `tools/list` + `MCP_WRITE_TOOLS`；导入发现模型仍与核心校验分离 | 旧请求封套、token、幂等回执兼容 |
| 11 | 技能与客户端（发现→采集→补查→预检提交→精确读回→独立确认） | **由 #321 承载（未开始）** | #321 OPEN；依赖 #315/#303/#307 等 | `.agents/skills/roster-ingestion-pipeline` + `lib/roster-import-client.ts` 旧契约 | 技能仍可调用旧公开接口；不得把 collected 当 migrated |
| 12 | 日志与配置（独立日志/配置接缝，清日志不清审计） | **本阶段不切（独立日志/配置 seam）** | 无票，ADR §6 明确独立 | `.runtime-logs/events.db`（独立 worker）+ `service_credential` | `/api/logs*`、MCP 日志工具、`/api/settings/credentials*` 均可读 |
| 13 | 数据库与缓存（初始化迁移/运行连接分责/有界快照/限定缓存/worker/索引实测） | **由 #316 承载（未开始）** | #316 OPEN | `useDb` 在打开时迁移/种子；summary cache、enterprise worker、索引现状保留 | 旧库路径、只读快照、worker 语义、索引不重建 |
| 14 | 兼容与运维（账本/固定备份/影子对照/回滚各留回执/旧ID可读） | **由 #324 承载（验收已登记，未执行）** | #324 OPEN（scope:L 验收票） | `import_batch/import_receipt` 账本、platform snapshot/diff、replay、`DEPLOYMENT.md` 回滚程序 | 旧 ID/hash/回执/深链/原文件/inline 全部保留 |

## 2. 逐组登记

### 第 1 组：平台三业务（入口/归档/详情/本地业务查询）

**状态：由 #455 slice 2 承载（待开票）；其中「本地三来源查询」已切换。**

- **owner / 稳定接缝**
  - 企业读模型：`lib/roster/enterprise-roster.ts`（列表/详情/导出共用），经 `server/utils/enterprise-read.ts` 的 native worker 执行。
  - 平台业务详情：`readPlatformBusinessDetails`（`server/utils/platform-business-detail-read.ts:13`）。
  - 比对：`attachPlatformEvidence`（`lib/comparison-platform.ts:139`）。
  - 差异：`listRosterDifferences`（`lib/roster/difference-list.ts:20`）+ `readQueryAssessments`（`lib/roster/query-assessment.ts:182`）。
- **主要旧调用**
  - `lib/roster/enterprise-roster.ts:8,1123`：`readPlatformBusinessDetails(db, id, queries, relations)`，`queries`/`relations` 来自 `platform_query`/`platform_relation`。
  - `server/utils/platform-business-detail-read.ts:13-30`：按关系逐条 `normalizePlatformRelation`，再分组；旧 raw 字段参与冲突判定。
  - `lib/comparison-platform.ts:193-209`：按 `enterpriseId` 读 `platformQuery`/`platformRelation`；`:229` 把 `rawFields` 映射到比对证据。
  - `server/api/comparison.get.ts:138`：`attachPlatformEvidence(...)`。
  - `lib/roster/difference-list.ts:62-66`：按 `evidenceQueryId` 读 `platform_query`/`platform_relation`。
  - `lib/roster/query-assessment.ts:34-38,52,57,62,228,237`：`json_extract(q.collection_evidence, ...)` 与 `platform_relation` 查询。
  - 页面：`pages/index.vue`（企业列表）、`pages/enterprises/[id].vue`（详情）、`pages/comparison.vue`（比对）、`components/RosterDifferenceTable.vue`、`components/PlatformRecords.vue`、`components/PlatformBusinessHistory.vue`。
- **已切换的子项（不要写成整组已切）**
  - 申报：`/platform-declarations`、`/api/platform/declarations`、MCP `list_platform_declarations`；读 `platform_apply_projection`（#452/#453）。
  - 关联办理：`/platform-business-processes`、`/api/platform/business-processes`、MCP `list_platform_business_processes`；读 `platform_business_projection`（#457/#458）。
  - 认定目录：`/platform-recognized-directory`、`/api/platform/recognized-directory`、MCP `list_platform_recognized_directory`；读 `platform_recognized_projection`（#461/#462）。
  - 上述三页的查询服务分别在 `server/utils/platform-declarations.ts`、`platform-business-processes.ts`、`platform-recognized-directory.ts`。
- **当前实际读路径**
  - 企业列表/详情：`record/event/evidence` + `platform_query/relation`（`platform.businessRecords` 已复用身份分组，但观察内容仍由旧 raw 关系构成）。
  - 比对/差异：`platform_query/relation` + `difference_reason` + `record_correspondence`。
  - 本地三来源查询：各自 typed 投影。
- **为什么不由本票切**
  - 本组横跨四个用户可见面；#455 的 slice 2 要求先选一个面做「同一隔离输入、同一时点」的旧/新对照。未做对照前切换，无法证明行数、分页、筛选、未知/冲突、资格/final/proof 定位不变。
- **旧 reader 保留与回退**
  - 企业详情响应中的 `queries`/`relations` 与 `businessRecords` 均保留；`readPlatformBusinessDetails` 不删。
  - 比对/差异旧 reader 保留；不引入新决定 writer。
  - 回退条件：slice 2 的对照出现未批准差异时，消费者继续走旧 reader；旧 ID 仍可定位。

### 第 2 组：来源与采集（封套/身份版本观察/单查批查/历史投影/原档核对/分页/重放）

**状态：本阶段不切（原始封套/原档接缝）。**

- **owner / 稳定接缝**：`server/utils/platform-live-query.ts`（单查）、`server/utils/platform-batch-query.ts`（批量）、`lib/platform/read.ts`（归档/原档分段）、`server/utils/platform-reconcile.ts`（核查）；身份/版本/观察是共享元数据，不是本组读取的 oracle。
- **主要旧调用**
  - 归档列表：`lib/platform/read.ts:108 listPlatformQueries`；`server/api/platform/queries.get.ts:84`；MCP `list_platform_queries`（`server/mcp/tools/list_platform_queries.ts:18`）。
  - 原档分段：`server/api/platform/queries/[queryId]/evidence.get.ts:28 readPlatformQueryEvidence`；MCP `get_platform_query_evidence`。
  - 实时单查：`server/api/platform/query.post.ts`、`server/utils/platform-live-query.ts`；MCP `query_platform`（`server/mcp/tools/query_platform.ts:12`）。
  - 批量：`server/api/platform/batches/index.post.ts:15`、`server/api/platform/batches/[batchId].get.ts:19`、item/retry 路由；`server/utils/platform-batch-query.ts`。
  - 快照：`server/api/platform/snapshots.get.ts:36`、`/api/platform/snapshots/diff`；`platform_export_batch/row`。
  - 重放/历史投影：`server/api/roster/import/replay.post.ts:27`（收敛 `record_evidence.source_file`）；`platformRecordObservations` 仍经统一预检/提交。
  - 平台核查：`server/utils/platform-reconcile.ts:45` 只调用 `preflightRosterImport`/`commitRosterImport`，不直写 SQL。
- **当前实际读路径**：`platform_query`/`platform_relation` 的 `raw_fields`、`collection_evidence`、`source_text`、原页序；`platform_export_batch/row`；批量 `job.result` 分段。身份/版本/观察由 `readPlatformBusinessMetadata` 等共享接缝按需读取，但不替代原始封套。
- **本阶段不切的理由（收益/风险/依赖）**
  - 收益低：这些消费者要回答「原平台返回了什么、哪一页、第几行、重放是否同载荷」，typed 投影刻意不含未知键与完整原文。
  - 风险高：把原档/重放切到 typed 会丢失未建模字段、原始分页终止判据与冲突证据，直接违反 ADR §2「raw 负责完整溯源」与 §7「不兼容可退旧 reader」。
  - 依赖不成立：#298/#299/#300 是类型保真、完整分页、异载荷拒绝的**修复**，不是消费者切换；三票已 CLOSED，但并未要求把原档读取迁到 typed。
- **旧调用仍可读的边界**
  - 原 query/relation/export ID、`raw_fields`、`collection_evidence`、页快照、重放回执全部可读。
  - 新 typed 投影是 additive；未投影历史仍按原 `relationId` 隔离，不伪造字段。
  - 本组不删除、不改写任何原观察或原文件。

### 第 3 组：正式公布（原值/事件/导入追加/更正归并/历史详情导出）

**状态：由 #303 承载（部分已切）。**

- **owner / 稳定接缝**：`server/api/roster/export.get.ts`（旧同步导出）、`server/utils/official-evidence.ts`（revision 写）、`server/utils/official-evidence-read.ts`（公开读）、`lib/roster/official-published-presentation.ts`（展示投影）；底层 `record/record_event/record_evidence/source_document` 与 `official_evidence_row_revision`。
- **主要旧调用**
  - 企业总表同步导出：`server/api/roster/export.get.ts:1-5,77-110` 走 `allRosterEnterprises`（`lib/roster/enterprise-roster.ts:615`）与 `first-recognition` 的出处文字；仍以 `record_evidence` 首条/容器原值呈现。
  - 正式事件/出处：`server/api/roster/events/[id].get.ts`、`server/api/roster/evidence/[id].get.ts`；`server/utils/official-evidence.ts:117` 写 revision，`server/utils/official-evidence-read.ts:41` 读公开投影。
  - 历史/首次认定：`lib/roster/first-recognition.ts:54`；`server/utils/record-comparison-formal.ts:40`。
  - 页面/组件：`pages/enterprises/[id].vue` 的认定历史、`components/record-correspondence/OfficialEvidence.vue`。
- **已切换的子项**
  - 详情/正式来源/当前查询：`lib/roster/enterprise-roster.ts:981 readPublicPublishedNames`、`:1063`；`server/utils/record-correspondence-read.ts:93`；`lib/roster/current-qualified-query.ts:112`；页面 `pages/enterprises/[id].vue:140,184`、`pages/current-enterprises.vue:76,132`。证据：提交 `8a591b0f`（#356，CLOSED/COMPLETED）。
  - 当前工作簿逐出处名称：`lib/roster/current-workbook-presentation.ts`、`lib/roster/current-workbook.ts` 消费 `workbookPublished`。证据：`b3bb4fad`（#355，CLOSED）。
- **当前实际读路径**：新展示面读 `official_evidence_row_revision` 的 latest/revision，按 `evidenceId` 关联；缺 sidecar 明确 `unknown_legacy`。旧同步导出/台账/recognitions/归并快照仍读旧容器原值。
- **为什么仍由 #303 承载**
  - #303 的验收包含「历史详情与导出备注使用逐出处原值」；#356 明确把「旧 `/api/enterprises/:id`、旧同步 export、台账/recognitions/归并快照」列为延期，不能宣称 #303 已完成。
  - #302（按出处行保存原值/追加佐证）仍 OPEN；其子片 #349–#351、#355/#356 已合入，但母票未完成。
- **旧 reader 保留与回退**
  - 旧 event/evidence 字段、ID、深链、PDF 页码/文件定位不变；`record.name_raw` 仍只表示旧容器上下文。
  - 新投影以 `availability=unknown_legacy/unavailable` 保留失败与缺失；展示失败不删除旧详情。
  - 回退：展示层可停止读 `publishedPresentation`，继续用旧字段；不得反向把 sidecar 名称写回资格裁定输入。

### 第 4 组：企业主体（资料/断言维护/迁移事实/维护页/差异/资格/技能）

**状态：由 #306/#307 承载（未开始）。**

- **owner / 稳定接缝**：`server/utils/enterprise-profile.ts`、`server/utils/alias-maintenance.ts`、`lib/roster/current-qualification.ts` 的 difference head 读取、`lib/roster/difference-list.ts`；目标接缝是独立「迁入/迁出/注销」事实及其确认/撤回历史。
- **主要旧调用**
  - 当前资格：`lib/roster/current-qualification.ts:421-472` 读 `difference_reason` head 的 `reason_code`（`moved_in/moved_out/deregistered`）、`moved_in_*` 列与 `current_qualification`；`:650-660` 由最新 moved 记录推导 `region.status`，由 `deregistered` 推导主体终止。
  - 差异列表/详情：`lib/roster/difference-list.ts:71`、`lib/roster/enterprise-roster.ts:863 movedInOf`、`components/RosterDifferenceTable.vue:150`、`components/RosterEnterprisePanel.vue:535`、`components/ComparisonReconcile.vue:181`。
  - 写入：`server/utils/enterprise-profile.ts:43 patchEnterpriseProfile`、`server/utils/alias-maintenance.ts:74 maintainEnterpriseAlias`；路由 `/api/roster/enterprises/:id/profile`、`/aliases/*`；MCP `patch_enterprise_profile`/`maintain_enterprise_alias`。
  - 页面：`pages/enterprises/[id].vue`、`pages/index.vue`、`components/EnterpriseDrawer.vue`。
- **当前实际读路径**：差异决定表 + `difference_reason` 的 `moved_in_*` 可空列；没有独立事实表，因此「主体事实」与「称号解释」仍共用一个 head。
- **为什么未切**：新事实模型尚不存在；现在把读路径改到「另一个列名」只是改名，不能解决「替换解释会撤掉迁移事实」「撤回后复活」的风险。必须先由 #306 建立独立事实，再由 #307 切维护页/资格/导出。
- **旧调用仍可读的边界**：旧 `difference_reason` head、movedIn 列、别名与审计全部保留；新事实只能 additive，不能回写旧列或伪造未给出的城市/年份/批次。
- **技能边界**：`references/difference-investigation.md` 仍可按旧流程查证，但不得声称新主体事实已落地（见第 11 组）。

### 第 5 组：对应与年度（候选/确认/驳回/解除/全过程/final/proof）

**状态：已切换（#320，合入 `81a50de0`；范围为候选/年度读取路径）。**

- **owner / 稳定接缝**：`server/utils/platform-source-facts.ts:16 readPlatformObservationFacts` 按接口分发；三个来源模块各自拥有 typed 字段与 legacy fallback：
  - `server/utils/platform-declarations.ts`
  - `server/utils/platform-business-processes.ts`
  - `server/utils/platform-recognized-directory.ts`
- **范围边界**：本组「读取路径」已切到来源专用事实；确认/驳回/解除/proof 仍由既有 `record_correspondence`、decision-lifecycle、proof 接缝提供，不因新读模型改写决定。
- **当前实际读路径**
  - 年度：`server/utils/event-annual-process-read.ts:24 readEventAnnualProcess`；`:92-114` 默认 `useSourceFacts=true`，先按 owner/title/role 限定 relation IDs，再调来源专用事实接缝。
  - 候选：`lib/roster/current-qualification.ts:287 readPlatformComparisonProcesses` → `server/utils/platform-comparison-input.ts:9` → `annual-correspondence-read.ts`。
  - 查询/证据/决定仍由既有 `record_correspondence`、proof、decision-lifecycle 接缝提供；新读模型不拥有决定 writer。
- **主要旧调用（保留作回退/对照）**
  - `server/utils/event-annual-process-read.ts:112-113`：`useSourceFacts=false` 时走 `normalizePlatformRelation`，供冻结的 comparison admission 保持原 SQL/载荷契约。
  - `server/utils/platform-legacy-relation-read.ts:50 readLegacyRelationRows`：对尚未投影的历史观察，只读七个允许的 process key 与所需原列，回退既有规范化。
  - `server/utils/platform-comparison-input.ts:9`：仍把年度读结果映射到 comparison 输入，不新建第二套年度算法。
- **旧 reader 保留与回退**
  - 未投影历史不会因回填未执行而从查询面消失；回退路径有界、只读、按关系 ID 批量。
  - 旧 `relationId/queryId`、观察级决定、拒绝/解除保护、sourceGeneration 规则不变。
  - 若新事实与旧规范化冲突，按现有 conflict 字段保留，不以新 reader 自身当唯一 oracle。
- **证据**：`tests/source-specific-facts-320.test.ts`、`tests/event-annual-process-read.test.ts`、`tests/platform-comparison-input.test.ts`；`docs/reports/real-data-320.md`；docs `platform-business-record-contract.md`「来源专用事实读取与候选/年度消费（#320）」。

### 第 6 组：当前资格与导出（周期/优质中小企业 HTTP/MCP/页面/三称号工作簿）

**状态：由 #468 承载（未切）。**

- **owner / 稳定接缝**：`current-qualification` + `current-candidates` + `current-workbook`；HTTP/MCP/页面/异步工作簿必须同一资格规则。
- **主要旧调用**
  - `lib/roster/current-candidates.ts:6-12 currentCandidateSql`：直接 union `platform_relation r join platform_query q`（仅取候选 ID）。
  - `lib/roster/current-qualification.ts:544-558 filterSource`：`json_extract(q.collection_evidence,'$.pages')`、`effectiveConditions.rddqrq/whpcyear/whpc`、`json_extract(r.raw_fields,'$.rddqrq/whpcyear/whpc')`，并要求 `source='queryBusList'`、`combination='and'`、`completeness='complete'`、`fullRange=1`。
  - `lib/roster/current-qualification.ts:184-187,421`：平台引用/工作簿事实直接读 `platform_relation`。
  - `lib/roster/current-workbook.ts:9,71-72,92`：候选 SQL + 全量 T2 + 流式工作簿。
  - 入口：`server/api/roster/current-enterprises.get.ts:63`；MCP `list_current_qualified_enterprises`（`server/mcp/tools/list_current_qualified_enterprises.ts:14`）；页面 `pages/current-enterprises.vue`；异步导出 `server/utils/jobs/current-roster-export.ts:16` 与 `/api/roster/exports/current/*`。
- **当前实际读路径**：`platform_relation.raw_fields` + `platform_query.collection_evidence` 的 JSON 解释；recognized typed 投影（#461/#462）尚未进入资格/导出。
- **为什么未切**： #468 仍 OPEN；切换必须先在固定隔离副本上对照 `total/uncertainTotal/publishedPending`、行集合、分页、`q/district/recognitionFrom+To/validYear/maintenanceYear+maintenanceBatch`、`qualificationAssessment`（407-v2）与三称号工作簿，而当前没有这些对照回执。
- **旧 reader 保留与回退**：旧 current reader、`responseVersion=current-qualified-408-v1`、`CURRENT_RULE_VERSION=current-roster-116-v9`、工作簿列/规则全部保留；#468 只能 additive 切换，不兼容时显式退回旧 reader。
- **风险**：若不补此组，typed 投影会重演 ADR §5 的「建好表、0 读取方、最终冻结」；因此它是 slice 3 的必做项，不是可选优化。

### 第 7 组：文件内容（内容/依赖/恢复/上传页/预览/出处/备份恢复）

**状态：由 #311/#312 承载（未开始）。**

- **owner / 稳定接缝**：`server/utils/stored-files.ts`、`server/utils/file-maintenance.ts`、`server/api/files/*`、`server/api/roster/evidence/pages.post.ts`；`stored_file`（ID/路径/显示名/内容身份）+ `stored_file_part` + 文件维护审计；正式出处通过 `record_evidence.source_file` 字符串路径引用。
- **主要旧调用**
  - 列表/读取：`server/api/files/index.get.ts:112`（首次懒回填 + 扫盘）、`server/api/files/[...path].get.ts`、`server/api/files/[id].get.ts`、`server/api/files/[id].head.ts`。
  - 内容身份/回填：`server/utils/stored-files.ts:142 scanFileStore`、`:238 backfillStoredFiles`、`:301 backfillFromDisk`、`:608 getStoredFile`。
  - 维护：`server/api/files/[id].patch.ts`、`server/utils/file-maintenance.ts:55 maintainStoredFileSync`、`server/api/files/[id]/maintenance.get.ts`。
  - 删除/恢复：`server/api/files/[id].delete.ts:10,60`（默认软移出；`deleteDisk=1` 真删）、`server/api/files/[id]/restore.post.ts:27`、`server/utils/stored-files.ts:636/691/715/728`。
  - 预览/出处：`server/api/pdf-pages.get.ts`、`server/api/roster/evidence/pages.post.ts`、`pages/preview.vue`、`components/files/PdfViewDialog.vue`。
  - MCP：`list_files`/`get_file`/`update_file`/`remove_file`/`restore_file`；页面 `pages/files.vue`、`components/files/*`。
- **当前实际读路径**：按 `stored_file.id` 或 `rel_path` 读取；`record_evidence.source_file` 是路径字符串；软移出只写 `removed_at`，磁盘字节保留。
- **为什么未切**：#311 要解决「同路径换字节后旧出处/OCR 仍指向新内容」，#312 要解决「物理删除失败/DB 回滚不能恢复文件」。在内容身份与可恢复删除协议落地前切换读路径，会把「路径」误当「内容」。
- **旧调用仍可读的边界**：旧 file ID/路径/显示名/bytes/sha256、维护审计、软移出状态、正式出处路径均可读；`deleteDisk=1` 已删除的字节当前不可恢复，这是 #312 的明确缺口，不是本层能补的。
- **回退**：新内容身份/删除意图只能 additive；旧 `stored_file` 行与路径引用不重写，回退时继续按旧路径读。

### 第 8 组：OCR与解析（采集/校对/解析各拥有输入输出版本）

**状态：已切换（#308/#309/#310，均 CLOSED）。**

- **owner / 稳定接缝**：`ocr_result` 页版本（`id:revision`）+ 解析输入 `inputRef`（文件 sha256 或实际采用 OCR 页版本）+ `expectedVersion` 幂等封套。
- **主要旧调用（读取/兼容面）**
  - OCR：`server/utils/ocr-result.ts:169 writeOcrResult`、`:245 listOcrResults`、`:340 validOcrExpectedVersion`、`:360 deleteOcrPage`；`server/utils/ocr-page-lifecycle.ts:20`；路由 `/api/files/[id]/ocr-pages/[page]` GET/PUT/DELETE、`/api/ocr-results/*`；MCP `save_ocr_result`/`delete_ocr_result`；页面 `pages/ocr.vue`、`components/ocr/OcrWorkbench.vue`。
  - 解析：`server/utils/parse-maintenance-105.ts:17-25 parsePreflight310/parseInputRef310`、`:75-115 currentInput310`（文件 sha/stat + OCR 页版本核验）、`:168-179` requestHash/expectedVersion；路由 `/api/files/[id]/parse-result/preflight|commit|history`；MCP `preflight_file_parse_result`/`commit_file_parse_result`/`save_parse_result`/`get_file_parse_history`；`server/utils/parse-result.ts:20` 只写 `stored_file_part`/`parse_state`，不碰台账。
- **切换后的读路径**：保存/删除页校验 `expectedVersion`；解析预检冻结实际输入（文件内容身份或实际采用的 OCR 页版本），提交重核；输入冲突 409 要求重读，不能用「最新输入」覆盖。
- **对照口径**：本组是版本/输入接缝修复，不存在「旧/新两套 reader」；oracle 是并发保存/删除 409、解析输入变更 409、旧输入不覆盖新结果、旧无依据 unknown。
- **旧 reader 保留与回退**
  - 旧解析输入依据缺失读作 `unknown`（不拿当前 hash/版本倒填）；旧 `save_parse_result` 载荷仍可用，但带 `inputRef` 时必须是完整现代封套。
  - 旧读取接口（`get_ocr_result`、`get_file_parse_history` 等）保留；不删除旧行、不重算旧输出。
- **证据**：`tests/parse-input-310.test.ts`、`tests/ocr-publication-309.test.ts`、`tests/ocr-page-lifecycle-106.test.ts`、`tests/ocr-result.test.ts`。

### 第 9 组：后台任务（runner 外壳 + 各 kind 本义摘要）

**状态：由 #314 承载（未开始；#313 已 CLOSED，阻塞已解除）。**

- **owner / 稳定接缝**：`server/utils/job-runner.ts`（执行外壳）、`server/utils/job-specs.ts`（kind 注册）、`server/utils/task-center-http.ts`（当前投影）；各 kind 的参数/结果/摘要语义应由 kind 自己拥有。
- **主要旧调用**
  - `lib/task-center.ts:5-12`：`TASK_GROUPS`/`TASK_LABELS` 硬编码 kind 分组与中文名。
  - `server/utils/task-center-http.ts:23-78`：SQL `json_extract(j.result, '$.collection...')`、`json_extract(j.params, '$.titleCode')` 等，按 kind 反解业务 JSON；`:84-140` 在 JS 里再解析 `items/counts/reconcileCollection/exportMeta/discoveryMeta`。
  - `server/utils/job-specs.ts:36 registerJobSpecs` 注册 7 个 kind；`server/api/task-center/*`；页面 `pages/tasks.vue`、`components/tasks/TaskDetail.vue`。
- **当前实际读路径**：`job.params/result/progress` 任意 JSON；任务中心用 SQL/JS 适配各 kind，公共 runner 只负责生命周期。
- **为什么未切**：#314 要求「按 kind 提供类型明确的参数/结果/摘要读模型」，并把取消/重试/恢复、异常结果、未知旧 kind 明确化；当前没有这样的 typed read model，提前拆 SQL 只是把硬编码搬到另一个文件。
- **旧调用仍可读的边界**：所有旧 job 行、进度、取消/重试、历史 checkpoint 保留；未知/新 kind 继续在「全部」页可见，不因未适配而隐藏。
- **禁止**：不把「采集 complete」当「核对完成」；不强制迁移历史 checkpoint。

### 第 10 组：HTTP与MCP（共享领域命令/校验/schema/鉴权/公开读回）

**状态：由 #315 承载（未开始）。**

- **owner / 稳定接缝**：`server/api/**` 的 route meta、`server/mcp/index.ts`、`server/utils/mcp-auth.ts`、`server/utils/openapi-guard.ts`；导入领域命令的核心校验；读写鉴权边界。
- **主要旧调用**
  - 导入发现：`server/api/roster/import/preflight.post.ts:15` 与 `commit.post.ts:14` 各自维护 OpenAPI 请求体；MCP `preflight_roster_batch`/`save_roster_batch` 复用同一核心但发现描述独立。
  - 能力/发现：`server/api/platform/capabilities.get.ts:3`、`server/mcp/index.ts:52`、`server/utils/mcp-auth.ts:39 MCP_WRITE_TOOLS`。
  - 契约守卫：`server/utils/openapi-guard.ts`、`scripts/verify-prod-openapi.mjs`。
- **当前实际读路径**：各路由的 `defineRouteMeta` 与 MCP tool 描述是「发现面」；核心校验仍在 `server/utils/roster-import.ts` 等，二者可能漂移。
- **为什么未切**：#315 专门解决「发现 schema 与真正核心校验漂移」和旧载荷兼容；它不引入新领域模型，不能用一次性批量替换完成。当前改 schema 容易收窄并拒绝合法旧载荷。
- **旧调用仍可读的边界**：旧请求封套、token 头（`Authorization`/`X-MCP-Token`）、幂等回执、只读工具继续可用；新增领域模型按各自票扩展，不强制统一封套。

### 第 11 组：技能与客户端（发现→采集→补查→预检提交→精确读回→独立确认）

**状态：由 #321 承载（未开始）。**

- **owner / 稳定接缝**：`.agents/skills/roster-ingestion-pipeline/SKILL.md` 与 `references/*`、`examples/*`、`lib/roster-import-client.ts` 的公开客户端。
- **主要旧调用**
  - `.agents/skills/roster-ingestion-pipeline/SKILL.md:14`（capabilities + REST/MCP）、`:23`（预检/提交/读回、禁止直写 SQLite）。
  - `references/platform-query.md:27-51`：单查/批量/重试/上限/归档，仍按旧 `POST /api/platform/query`、`/api/platform/batches`、`recognizedResultToImport` 描述。
  - `references/workflow.md`、`references/difference-investigation.md`、`references/uscc-recovery.md`、`examples/investigate-platform.mjs`。
  - 客户端：`lib/roster-import-client.ts:558,647`（preflight/commit/replay 路径与 `createRosterImportClient`）。
- **当前实际读路径**：技能直接调用公开 REST/MCP；没有独立运行时读模型，风险在「用词/流程」把「已采集/已入库/已确认」混为一谈。
- **为什么未切**：#321 依赖 #315/#303/#307 等合同与主体事实切换；在合同未稳定时改技能，会把未落地能力写成已可用。
- **旧调用仍可读的边界**：技能仍可调用旧公开接口；旧示例/客户端不删除。明确禁止：不把 `collected` 当迁移完成，不把平台查询成功当业务确认，不读取/展示凭据。
- **回退**：技能文本可回退到当前版本；已提交的导入回执/业务事实不受技能文本影响。

### 第 12 组：日志与配置（独立日志/配置接缝，清日志不清审计）

**状态：本阶段不切（独立日志/配置 seam）。**

- **owner / 稳定接缝**：`lib/logging/service.ts`/`lib/logging/sqlite-worker.ts` 的独立运行日志（`.runtime-logs/events.db`，worker 持有）+ `server/utils/credential-state.ts` 的 `service_credential` 配置表；与业务审计/业务读模型分开。
- **主要旧调用**
  - 日志：`lib/logging/index.ts:16-18`（`NUXT_LOG_DIR || './.runtime-logs'`）、`lib/logging/sqlite-worker.ts:47,69-82`（`events.db` 的 `log_events/log_policy/log_collection`）、`lib/logging/service.ts:74 createLogService`；`/api/logs/*`、MCP `list_runtime_logs/get_runtime_log/get_runtime_log_policy/set_runtime_log_policy/clear_runtime_logs`；页面 `pages/logs.vue`。
  - 配置：`server/utils/credential-state.ts:22`（`service_credential`）、`server/utils/credentials-http.ts:3`、`/api/settings/credentials/*`（凭据仅 REST 读取/揭示，MCP 不暴露凭据工具）；页面 `pages/settings.vue`、`components/settings/CredentialSettings.vue`。
- **本阶段不切的理由（收益/风险/依赖）**
  - 收益：日志/配置不承载 14 组业务读模型；切到业务 typed 投影没有收益，只会把运行诊断与业务审计混在一起。
  - 风险：`clear_runtime_logs` 只清独立日志，不能清业务审计；若并入业务库/业务读模型，会破坏「清日志不清审计」的边界。
  - 依赖：ADR §6 指定「独立日志/配置接缝，可信入口沿用 #127」；#127 的未授权扩展边界未在本票重新打开，不能声称已泄露。
- **旧调用仍可读的边界**
  - 日志：旧 `log_events` 按 retention/policy 可读，清空只影响日志库；业务 `import_receipt/audit` 不受影响。
  - 配置：旧 `service_credential` 键、读取/揭示接口与「不入库不入 Git」边界保留；配置值不进业务 DTO。
- **不切不等于冻结**：后续如确需把日志/配置接入统一运维读模型，另开票并单独做权限/审计对照；本阶段不把其列入 14 组切换完成条件。

### 第 13 组：数据库与缓存（初始化迁移/运行连接分责/有界快照/限定缓存/worker/索引实测）

**状态：由 #316 承载（未开始）。**

- **owner / 稳定接缝**：`db/client.ts` 的 `useDb` 打开/缓存/迁移/种子；`server/utils/enterprise-read.ts` 的 worker 快照；`server/utils/platform-summary-cache.ts`；迁移与索引。
- **主要旧调用**
  - `db/client.ts:51-81`：`useDb` 按路径缓存、打开时 `migrate` 并写 `title` 种子；`readOnly` 由 `NUXT_DB_READONLY` 控制。
  - `drizzle.config.ts`：`dbCredentials.url = NUXT_DB_PATH || './data/roster.db'`；迁移目录 `db/migrations`。
  - 缓存：`server/utils/platform-summary-cache.ts:32`（committed-only、`data_version` 失效、有界 LRU）。
  - worker/快照：`server/utils/enterprise-read.ts:25`（单 native worker、FIFO、无共享连接）；`lib/roster/enterprise-read-snapshot.ts`。
  - 索引实测：`docs/sqlite-index-performance.md`、迁移 `0031/0033/0034/0035`。
- **当前实际读路径**：普通读连接也可能触发迁移/种子；运行连接与启动职责未分。
- **为什么未切**：#316 要先把「启动负责迁移/种子、运行 `useDb`/只读快照职责明确」拆开；在此之前把缓存/worker/索引包装成新读模型，无法证明不改变快照生命周期或让只读连接执行 DDL。
- **旧调用仍可读的边界**：旧 DB 路径、迁移历史、只读快照、worker 队列、索引与 `data_version` 失效语义保留；不合并跨 await 事务，不重建旧表。
- **子项说明**：缓存/worker/索引实测不是「新 typed 消费者」，本阶段只登记现状；#316 只承载启动/运行分责，不宣称缓存/索引已完成重测。

### 第 14 组：兼容与运维（账本/固定备份/影子对照/回滚各留回执/旧ID可读）

**状态：由 #324 承载（验收已登记，未执行）。**

- **owner / 稳定接缝**：`server/utils/import-receipt-ledger.ts`、`server/utils/platform-snapshots-http.ts`、`server/api/roster/import/replay.post.ts`、`DEPLOYMENT.md`；`import_batch/import_receipt` 账本、platform snapshot/diff、replay、部署/回滚程序、影子对照回执。
- **主要旧调用**
  - 账本：`server/utils/import-receipt-ledger.ts:19 recordImportReceipt`；`/api/roster/import/receipts/*`、`history/items/request`；MCP 对应读工具。
  - 快照/差异：`server/api/platform/snapshots.get.ts`、`snapshots/diff.get.ts`、`server/utils/platform-snapshots-http.ts:26`；`platform_export_batch/row`。
  - 重放：`server/api/roster/import/replay.post.ts:27`（只收敛出处指针，不创建业务事实）。
  - 运维：`DEPLOYMENT.md:33` 要求保存镜像/源码 SHA/状态目录，在线 backup 只读且协调文件库，不能直接复制活跃 DB/WAL。
  - 影子对照：`tests/platform-recognized-directory-shadow.test.ts`、`tests/platform-business-processes-shadow.test.ts`、`docs/reports/real-data-320.md`。
- **为什么未执行**：#324 是 scope:L 组合验收票，不是新读模型；它要求固定集成 SHA/tree、在一致备份隔离卷上跑旧表/指纹/回执/审计/文件保护、HTTP/MCP/任务/导出/UI 组合与性能对照。当前没有这些运行回执。
- **旧调用仍可读的边界**：旧 ID/hash/回执/深链/原文件/inline 全部保留；本阶段不删旧列、不重写历史、不把局部 PASS 当 full。
- **不可单程票**：每项切换/回滚都要留回执；回滚不能恢复旧 DB 抹掉新提交，因此必须先有备份与可读回滚记录。

## 3. 「迁移完成」的可核验定义

只有同时满足以下条件，才能声称 14 组迁移完成；缺一项即未完成。

### 3.1 登记完整

- [ ] 14 组每组恰好一个状态：**已切换 / 由某票承载 / 本阶段不切**；无空白、无「待定」。
- [ ] 每组都有 owner + 稳定接缝 + 主要旧调用（文件 + 函数/端点/页面/任务/导出/技能）。
- [ ] 每组都有当前实际读路径；「由某票承载」有票号/切片与状态；「本阶段不切」有理由与旧调用可读边界。
- [ ] 本表与 issue 原表冲突处，以代码检索为准并单列（§5），不能复制旧表了事。

### 3.2 每组有对照或登记

- [ ] **已切换**组：有一份同一隔离数据、同一时点、旧/新 reader 只读的对照回执；至少覆盖行数与分页、筛选结果、字段与未知/冲突、资格与 final、proof 与审计定位中适用的维度。
- [ ] 对照差异清单单独留档；已批准的语义修复单列，不把新 reader 自身当唯一 oracle。
- [ ] **由某票承载**组：票内必须包含同样的对照要求；票未合入前，不得写成已切换。
- [ ] **本阶段不切**组：有书面理由与旧调用可读边界，不能只写「暂不」；后续若要切，必须另开票并补对照。

### 3.3 旧 ID 可读

- [ ] 旧 `queryId/relationId/sequenceNo`、`record/event/evidence`、`exportBatchId/exportRowId`、`correspondenceId/proofId`、`jobId/batchId/receiptId`、文件 ID、深链全部可定位。
- [ ] 旧 raw、canonical、hash、sourceFingerprint、revision、审计、回执不被重写或删除。
- [ ] 未投影/未映射历史明确标 `unknown/not_indexed/unverifiable`，不从当前值倒填。
- [ ] 新投影 additive；同内容版本冲突整批拒绝，不静默覆盖。

### 3.4 不可单程票

- [ ] 每个已切换组保留旧 reader 或显式开关；回退触发条件、负责人、回执写入验收记录。
- [ ] 回退不依赖「恢复旧 DB 抹掉新提交」；新提交/回执/审计在回退后仍可读。
- [ ] 删除旧表/旧列/旧接口只在 contract 阶段、有实际停用证明与独立授权后进行；本阶段不做。
- [ ] 每组的切换前后差异清单、回退记录、旧 ID 映射三者齐全，才可关闭该组。

### 3.5 机械核对

- [ ] 本文件 14 行总表无空状态；分组小节编号 1–14 齐全。
- [ ] 状态列无空值；每个状态只能是上述三种之一（或「由 #455 slice N 承载」这类明确承载形式）。
- [ ] 每个「已切换」组至少引用一条测试/文档/提交；每个「由票承载」组引用一个 OPEN/CLOSED 状态明确的票；每个「本阶段不切」组有理由段。
- [ ] 后续 slice 4 以此表为基线逐行销账，不另起一套分组。
- [ ] 维护规则：后续票只追加「状态/承载票/证据/日期」，不改写旧行；状态变更必须同时更新 §1 总表与对应 §2 小节，并注明新证据。

## 4. #455 的四个 ≤M 切片状态

| 切片 | 票/PR | 状态 | 证据 | 备注 |
|---|---|---|---|---|
| 1 | 本票 #455 / 本文件 | **本提交完成（文档）** | 本文件；定向 vitest 见 §7 | 只登记，不写生产代码；commit 见 `git log` |
| 2 | #455 slice 2（**待开票**） | **未开始** | 无票/无 PR；建议选企业详情或差异列表做首组真实切换 | 必须同输入前后对照；不得由本文件代替 |
| 3 | #468 | **OPEN / 未开始** | issue #468 正文与验收 | 第 6 组；三称号异步工作簿独立解析 |
| 4 | #455 slice 4（**待开票**） | **未开始** | 无票/无 PR；本文件仅提供基线 | 其余组切换或显式登记，形成最终完成定义 |

- 本票只填 slice 1；slice 2/4 尚未开票，不能写成「进行中」或「已完成」。
- slice 3 由 #468 承载，当前未切；不能把 #461/#462 的目录页当成第 6 组完成。
- 四项均要求独立 PR、可单独验收；后项在前项合入后推进。

## 5. 与 issue #455 原表的校正（代码检索，2026-11-04）

| 原表写法 | 实际（基线 `81a50de0`） | 证据 |
|---|---|---|
| 第 2 组「#298 open；#299 #300 已关闭」 | #298/#299/#300 均 **CLOSED**；它们是修复，不是消费者切换 | `gh issue view 298/299/300` |
| 第 1 组「未切，待开」 | 本地三来源查询已切（#453/#458/#462）；企业列表/详情/比对/差异仍未切 | `pages/platform-declarations.vue`、`platform-business-processes.vue`、`platform-recognized-directory.vue`；docs 三份 |
| 第 3 组「#302；#303 open」 | #302 OPEN；#303 OPEN；#355/#356 **CLOSED**，详情/来源/当前查询/工作簿已切 | `8a591b0f`、`b3bb4fad`；`lib/roster/enterprise-roster.ts:981,1063` |
| 第 8 组「已完成」 | #308/#309/#310 CLOSED；但这是版本/输入接缝，不是平行 typed 投影 | `parse-maintenance-105.ts:17-25`；`ocr-result.ts:340` |
| 第 9 组「#314」 | #314 OPEN；其阻塞 #313 已 CLOSED | `gh issue view 313/314` |
| 第 12 组「未登记」 | 本文件登记为 **本阶段不切**，并给出边界 | §2 第 12 组 |
| 第 14 组「验收已登记」 | #324 OPEN；尚无执行回执 | `gh issue view 324` |

其他状态：#468 OPEN；#306/#307/#311/#312/#315/#316/#321 OPEN；#313 CLOSED；#356 CLOSED/COMPLETED；#317/#318/#319/#320/#461/#462 CLOSED。

## 6. 证据来源与检索方法

### 6.1 命令（在 `81a50de0` 工作树执行）

```bash
git status --porcelain=v1 -b
git log --oneline -8
git merge-base --is-ancestor t3/implement-spec-455 HEAD
git rev-list --left-right --count t3/implement-spec-455...HEAD
gh issue view 455 --json number,title,state,body,labels
gh issue view <票号> --json number,title,state,stateReason,body

rg -n "platform_relation|platform_business_record|platform_(apply|business|recognized)_projection" lib server pages components tests db
rg -n "currentCandidateSql|current-qualification|currentQualified" lib server pages
rg -n "event-annual-process-read|readPlatformObservationFacts|useSourceFacts|platform-legacy-relation-read" lib server
rg -n "readPlatformBusinessDetails|readPublicPublishedNames|attachPlatformEvidence|listRosterDifferences" lib server pages
rg -n "movedIn|moved_in|deregistered|moved_out" lib server components pages
rg -n "task-center|json_extract\(.*job|TASK_GROUPS|TASK_LABELS" lib server pages components
rg -n "official_evidence_row_revision|record_evidence|source_document|readOfficial" lib server
rg -n "stored_file|stored_file_part|ocr_result|parse-result|expectedVersion|inputRef" lib server pages components
rg -n "service_credential|events.db|log_events|log_policy" lib server
rg -n "import_receipt|import_batch|platform_export_batch|snapshot" lib server db
```

### 6.2 关键文件

- ADR：`docs/adr/0001-source-domain-boundaries.md` §5/§6/§7。
- 现有契约：`docs/platform-business-record-contract.md`、`docs/platform-declarations.md`、`docs/platform-business-processes.md`、`docs/platform-recognized-directory.md`、`docs/data-model.md`。
- 当前资格：`lib/roster/current-candidates.ts`、`lib/roster/current-qualification.ts`、`lib/roster/current-workbook.ts`。
- 年度/对应：`server/utils/event-annual-process-read.ts`、`server/utils/platform-source-facts.ts`、`server/utils/platform-comparison-input.ts`。
- 正式事实：`server/utils/official-evidence.ts`、`server/utils/official-evidence-read.ts`、`lib/roster/official-published-presentation.ts`。
- 文件/OCR/解析：`server/utils/stored-files.ts`、`server/utils/file-maintenance.ts`、`server/utils/ocr-result.ts`、`server/utils/parse-maintenance-105.ts`。
- 任务/契约/日志/DB/运维：`lib/task-center.ts`、`server/utils/task-center-http.ts`、`server/mcp/index.ts`、`server/utils/mcp-auth.ts`、`lib/logging/*`、`db/client.ts`、`server/utils/import-receipt-ledger.ts`、`DEPLOYMENT.md`。

### 6.3 票号

#455、#296、#297、#298、#299、#300、#302、#303、#306、#307、#308、#309、#310、#311、#312、#313、#314、#315、#316、#317、#318、#319、#320、#321、#324、#349、#350、#351、#355、#356、#452、#453、#457、#458、#461、#462、#468。

## 7. 已运行与 UNRUN

### 7.1 已运行（2026-11-04，基线 `81a50de0`）

```bash
pnpm vitest run tests/source-specific-facts-320.test.ts tests/parse-input-310.test.ts tests/platform-recognized-directory-shadow.test.ts tests/ocr-publication-309.test.ts --maxWorkers=1 --no-file-parallelism
```

结果：4 个测试文件、66 个测试全部通过（exit 0，18.41s）。该运行只验证被引用接缝的既有回归，不是 14 组迁移的 fresh 验收；`ocr-publication-309` 的 stderr 是负路径用例的预期 409 日志，不是失败。

### 7.2 UNRUN / 未验证项

本票为纯文档，以下均 **UNRUN**，不得在后续报告中写成已通过：

- 未连接生产/活动 DB、WAL、原始文件或生产服务；未做真实副本影子对照。
- 未跑完整 HTTP/MCP 组合、任务/导出组合、异步工作簿独立解析。
- 未做桌面与 390px 页面实操/像素断言。
- 未跑 `pnpm typecheck`、`build`、全仓组合套件或性能对照。
- 未验证 PostgreSQL、部署、回滚或备份恢复；#324 的执行回执不存在。
- 未验证 #468 的当前资格/导出等价性；本文件只登记其旧调用。
- 未验证 #306/#307 的主体事实模型、#311/#312 的文件恢复协议、#314 的 typed 任务摘要、#315 的发现模型、#316 的启动/运行分责、#321 的技能同步。
- 本文件引用的行号是 `81a50de0` 的静态位置；后续提交可能漂移，复核时以文件内容为准。
