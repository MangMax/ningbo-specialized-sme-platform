# 平台分域读模型消费者迁移登记（#455 最终登记 / slice 4）

状态：**最终登记，不是 fresh PASS**。本文件盘点「谁仍在读旧路径」，给出 14 组状态、承载票、剩余未切清单、回退边界与「迁移完成」的可交付定义；不修改生产代码、数据库、页面或导出规则。

- 基线：集成分支 `t3/implement-spec-455` @ `3540f7fe`（#455 slice 3 合入后的 tip；本工作树分支 `t3/455-closeout`）。
- 上级：issue #455（scope:L）、#296、ADR `docs/adr/0001-source-domain-boundaries.md` §6/§7。
- 行号与结论均为该基线的静态代码检索结果；**所列行号可能随后续提交漂移**，复核时以文件内容与符号名为准。
- 「登记」不等于「已在隔离真实数据上对照通过」，也不等于 UI 桌面/390px、异步导出或性能已验收。所有未运行项见 §7。
- 切片证据：slice 1 `7a56e3e3`（本文件初版）、slice 2 `3207f0e4`（企业详情 typed 读取）、slice 3 `7b1164b8`（当前资格 recognized typed 读取）。

## 0. 登记口径

| 状态 | 含义 | 最低证据 |
|---|---|---|
| **已切换** | 该组消费者当前实际执行的是新领域接缝/来源专用读；旧 reader 仍保留且可显式回退。 | 代码入口 + 已合入票/提交 + 至少一条同输入对照或既有回归测试。 |
| **由某票承载** | 已有票（或 #455 明确切片）承担切换，当前仍读旧路径；复合组必须逐面带子状态，但顶层仍是三种之一。 | 票号/切片 + 当前状态 + 阻塞项；不得把「已开票」写成「已切换」。 |
| **本阶段不切** | 本阶段明确不切换。 | 收益/风险/依赖理由 + 旧调用清单 + 旧调用仍可读的边界。 |

> 只有上述三种顶层状态。复合组（第 1、6 组）仍落在「由某票承载」下，但必须逐面带子状态；顶层不得写成「已切换」，也不新增第四种状态。

三条硬规则：

1. 每组必须有 owner 与稳定接缝，不能只写「平台层」。
2. 旧调用必须写到文件 + 函数/端点/页面/任务/导出/技能，不能只写表名。
3. 已切换组必须写清旧 reader 保留与回退触发条件；「本阶段不切」组必须写清旧调用仍可读到什么、不能读到什么。

## 1. 14 组总表

| # | 影响组 | 状态 | 承载票 / 理由 | 当前实际主读路径 | 旧 reader / 回退 |
|---|---|---|---|---|---|
| 1 | 平台三业务（入口/归档/详情/本地业务查询） | **由 #455 slice 2 承载（复合：1a/1b 已切；1c/1d 本阶段不切）** | 1a #453/#458/#462；1b #455 slice 2 `3207f0e4`；1c/1d 无切换票，见 §2 | 1a 各 typed 投影；1b 企业详情 typed 字段优先，行集合/冲突仍由旧 relation；1c 企业列表 `record`/`platform_export_row`/`difference_reason`，对比/差异 `platform_query`/`platform_relation`；1d 原档 `platform_query`/`platform_relation` raw | 1b `typedFields=null` 回退 `normalizePlatformRelation`/raw；1c/1d 旧 reader/原档全部保留 |
| 2 | 来源与采集（封套/身份版本观察/单查批查/历史投影/原档核对/分页/重放） | **本阶段不切（原始封套/原档接缝）** | 无切换票；#298/#299/#300 是修复且已关闭 | `platform_query`/`platform_relation`/raw、`platform_export_*`；身份/版本/观察仅作共享元数据 | 全部原 query/relation/export ID、raw、分页、重放回执可读 |
| 3 | 正式公布（原值/事件/导入追加/更正归并/历史详情导出） | **由 #303 承载（部分已切）** | #303 OPEN；#355/#356 已合入 | 详情/正式来源/当前查询/当前工作簿读 `official_evidence_row_revision`；旧同步导出/台账仍读 `record/event/evidence` | 旧 record/event/evidence 字段与深链保留；新投影 additive |
| 4 | 企业主体（资料/断言维护/迁移事实/维护页/差异/资格/技能） | **由 #306/#307 承载（未开始）** | #306、#307 OPEN | `difference_reason` 的 `moved_in/moved_out/deregistered` 与 `moved_in_*` 列；资料/别名走既有 PATCH | 旧 head、movedIn 列、审计与别名 ID 保留 |
| 5 | 对应与年度（候选/确认/驳回/解除/全过程/final/proof） | **已切换（#320）** | #320 CLOSED，合入 `81a50de0` | `readPlatformObservationFacts` → 三来源 typed 读；未投影历史走 bounded legacy fallback | `useSourceFacts=false` 对照入口 + 旧 relation 原值保留 |
| 6 | 当前资格与导出（周期/优质中小企业 HTTP/MCP/页面/三称号工作簿） | **由 #468 承载（复合：资格见证+四消费者已切；候选 SQL 未切）** | #468 OPEN；`7b1164b8`；候选 SQL 明确未切 | recognized typed 筛选见证 + 同一评估器；候选枚举仍 `currentCandidateSql` 旧 union | `ROSTER_RECOGNIZED_FILTER_SOURCE=legacy` 或内部 option；旧 relation/query/响应版本保留；**#468 不得因本行关闭** |
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

**状态：由 #455 slice 2 承载（复合）。** 1a 本地三来源查询已切；1b 企业详情已切；1c 企业列表/对比页/差异列表本阶段不切；1d 归档/原档本阶段不切。顶层仍是「由某票承载」，不得把整组写成「已切换」。

#### 1a 本地三来源查询 — 已切换（#453/#458/#462）

- **入口/读路径**
  - 申报：`/platform-declarations`、`GET /api/platform/declarations`、MCP `list_platform_declarations`；查询服务 `server/utils/platform-declarations.ts`；读 `platform_apply_projection`（#452/#453）。
  - 关联办理：`/platform-business-processes`、`GET /api/platform/business-processes`、MCP `list_platform_business_processes`；查询服务 `server/utils/platform-business-processes.ts`；读 `platform_business_projection`（#457/#458）。
  - 认定目录：`/platform-recognized-directory`、`GET /api/platform/recognized-directory`、MCP `list_platform_recognized_directory`；查询服务 `server/utils/platform-recognized-directory.ts`；读 `platform_recognized_projection`（#461/#462）。
- **对照/证据**：三组票内影子对照与页面/HTTP/MCP 测试；文档 `docs/platform-declarations.md`、`docs/platform-business-processes.md`、`docs/platform-recognized-directory.md`。
- **旧 reader 边界**：企业详情/差异/对比仍保留旧 `platform_query`/`platform_relation` 归档行；三张 typed 投影 additive，不删除旧 reader。目录详情不返回 raw JSON，原档仍走 `GET /api/platform/queries/{queryId}/evidence`。

#### 1b 企业详情 — 已切换（#455 slice 2 / `3207f0e4`）

- **读取链**：`GET /api/roster/enterprises/{id}` → `getRosterEnterpriseDetail`（`lib/roster/enterprise-roster.ts:1123`）→ `readPlatformBusinessDetails`（`server/utils/platform-business-detail-read.ts:108`）→ `readPlatformTypedDetailFields`（同文件 `:51`）。
- **typed 读取**：按观察 `relationId` → `platform_business_observation.(version_id, record_id)` LEFT JOIN 三张来源投影，只读业务列；展示 `components/PlatformRecords.vue`、`components/PlatformBusinessHistory.vue` 优先 typed。
- **仍未切的部分**：行集合、`relationId/queryId/versionId`、企业归属、分组、对应决定、冲突标记仍由旧 `platform_query`/`platform_relation` 与 `normalizePlatformRelation` 提供；typed 只替换业务字段。这是「企业详情面的字段读切换」，不是整组平台三业务切换。
- **已批准差异**：投影存在但字段为 null 时展示「未提供」，不从 `raw_fields`/导入列/查询条件/批次/时间补猜；投影未建模字段（如 apply 的 `batch/province`）回退旧 relation 列。详见 `docs/platform-enterprise-detail-typed-switch.md`。
- **回退**：无观察映射（`not_indexed/missing_key/conflict/unverifiable`）或历史版本无投影 → `typedFields=null`，全部字段回退 `normalizePlatformRelation`/`rawFields`；旧 `queries`/`relations`/`businessRecords` 均保留。
- **证据**：`tests/enterprise-detail-typed-read-455.test.ts`、`tests/enterprise-detail-typed-ui-455.test.ts`；本提交 §7 重跑通过。

#### 1c 企业列表/对比页/差异列表 — 本阶段不切

- **状态与承载**：**本阶段不切**；无承载票。slice 2 只切企业详情，不能外推到本面。
- **旧调用**
  - 企业列表：`lib/roster/enterprise-list-selection.ts:46 selectEnterpriseCoordinates` 读 `record`/`record_event`/`platform_export_row`/`difference_reason`；`lib/roster/enterprise-roster.ts:601 listRosterEnterprises`、`:685 selectRosterEnterprises`；`server/api/roster/enterprises.get.ts`；页面 `pages/index.vue`。
  - 对比页/对比导出：`lib/comparison-platform.ts:139 attachPlatformEvidence` 读 `platform_query`/`platform_relation`/`difference_reason`；`server/api/comparison.get.ts:138`；`server/api/export.get.ts:124`；页面 `pages/comparison.vue`；组件 `components/ComparisonPlatformEvidence.vue`、`components/ComparisonQueryOriginals.vue`。
  - 差异列表：`lib/roster/difference-list.ts:20 listRosterDifferences`（`difference_reason` head + `platform_query`/`platform_relation` 证据）；`lib/roster/query-assessment.ts:34-38,182` 的 `json_extract`；`server/utils/difference-read.ts:24`；页面 `components/RosterDifferenceTable.vue`、`components/RosterEnterprisePanel.vue`。
- **不切理由**
  - 企业列表的成员/计数来自 `record`/`platform_export_row`/`difference_reason` 坐标，当前没有对应的 typed 投影消费者；直接换读取会改变「谁在列表里」的语义。
  - 对比/差异必须在同一隔离输入、同一时点比较行集合、分页、筛选、字段/未知/冲突、对应决定与 proof 定位；本阶段没有这些对照回执，也没有承载票。
  - 这三面共用 `difference_reason` 与旧平台证据；在 #306/#307 主体事实与 #303 正式事实尚未完成前切换，会把「差异原因」和「平台观察」混成新读模型。
- **旧调用仍可读的边界**：旧列表坐标、`difference_reason` head、旧 `platform_query/relation` 证据、对应决定与导出快照全部保留；显示语义不变。

#### 1d 归档/原档 — 本阶段不切

- **状态与承载**：**本阶段不切**；与第 2 组「原始封套/原档接缝」同一边界，无切换票。
- **旧调用**
  - 归档列表：`lib/platform/read.ts:108 listPlatformQueries`；`server/api/platform/queries.get.ts:18`；MCP `list_platform_queries`（`server/mcp/tools/list_platform_queries.ts:18`）。
  - 原档分段：`lib/platform/evidence-read.ts:30 readPlatformQueryEvidence`；`server/api/platform/queries/[queryId]/evidence.get.ts:28`；MCP `get_platform_query_evidence`。
  - 页面/组件：`pages/platform-queries.vue:34`；`components/PlatformQueryEvidence.vue:28`、`PlatformEvidenceChunk.vue:34`、`ComparisonQueryOriginals.vue:34`、`components/record-correspondence/SourceReader.vue`。
- **不切理由**：归档/原档要回答「原平台返回了什么、哪一页、第几行、未知键、完整原文、重放是否同载荷」；typed 投影刻意不含未知键与完整原文。切到 typed 会丢失未建模字段与原始分页证据，违反 ADR §2「raw 负责完整溯源」与 §7「不兼容可退旧 reader」。
- **旧调用仍可读的边界**：原 `queryId/relationId/sequenceNo`、`raw_fields`、`collection_evidence`、页快照、重放回执全部可读；本阶段不删除、不改写原观察或原文件。

#### 第 1 组整体回退

- 1b：`typedFields=null` 即回退旧字段；旧 relation/query/`normalizePlatformRelation` 保留。
- 1c/1d：旧 reader 原样保留，不引入新决定 writer；后续若要切，必须另开票并补同输入对照。
- 1a：typed 页面 additive；旧企业详情/原档读取仍可定位同一 query/relation ID。

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
  - 企业总表同步导出：`server/api/roster/export.get.ts:119 allRosterEnterprises`（`lib/roster/enterprise-roster.ts:615`）与 `first-recognition` 的出处文字；仍以 `record_evidence` 首条/容器原值呈现。
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

**状态：由 #468 承载（复合：资格见证+四消费者已切；候选 SQL 未切）；#468 仍 OPEN。** 不得写成整组已切换，也不得关闭 #468。

- **owner / 稳定接缝**：`current-qualification` + `current-candidates` + `current-workbook`；HTTP/MCP/页面/异步工作簿必须同一资格规则。
- **已切换的子面（`7b1164b8`）**
  - 资格见证：`lib/roster/recognized-filter-source.ts` 的 `recognizedFilterSourceSql`/`createRecognizedFilterSourceReader`；内容事实按 `platform_business_observation.relation_id` → `version_id` → `platform_recognized_projection` 读 `validity_date_raw/maintenance_year/maintenance_batch`。查询级 facts（`pages`/`effectiveConditions`/`status`/`completeness`/`fullRange`/`rdjb`）仍读 `platform_query.collection_evidence`，typed 不伪造这些字段。
  - 四消费者共用同一评估器：HTTP `server/api/roster/current-enterprises.get.ts:63` → `enterpriseReads.currentQualifiedJson`；MCP `server/mcp/tools/list_current_qualified_enterprises.ts:14`；页面 `pages/current-enterprises.vue`（只消费 HTTP）；异步工作簿 `lib/roster/current-workbook.ts:69,103,110`。
  - 证据：`tests/current-qualified-recognized-typed-468.test.ts`（5/5；影子对照 13 组筛选/分页、null 投影不回退、未投影回退、trim 差异、HTTP+MCP+工作簿同读者）；本提交 §7 重跑通过。
- **未切的子面：候选枚举**
  - `lib/roster/current-candidates.ts:6 currentCandidateSql` 仍 union `record`/`difference_reason`/`record_correspondence`/`platform_relation`；`lib/roster/current-workbook.ts:71,92` 与 `lib/roster/current-qualified-query.ts:108` 仍使用该候选 SQL。
  - 原因：`tests/current-candidate-covering-index-363.test.ts` 的 C04 冻结了 `currentCandidateSql` 的字节与 sha256；投影与观察都以 `platform_relation` 为根，按 relation union 的候选集合不会因投影存在/缺失而增减；若改为 observation/projection 优先，必须单独处理 C04、行数不变与未投影历史行证明。
  - 旧 relation/query/correspondence ID 在 typed/legacy 两路下相同。
- **旧 reader 与回退**
  - 运维：设置 `ROSTER_RECOGNIZED_FILTER_SOURCE=legacy`，所有当前资格读取使用切换前的 `filterSource` SQL（字节与切换前一致，无新增 join）。
  - 代码/测试：`listCurrentQualified(db, filter, { recognizedFactSource: 'legacy' })` 或 `createCurrentQualificationAssessmentReader(db, runtime, { recognizedFactSource: 'legacy' })`。
  - 按行自动回退：某 relation 没有 `platform_business_observation`/`platform_recognized_projection` 行时，该行内容事实走原 `raw_fields`；投影存在但字段 null 按「来源未知」，不回填 raw。
- **未变**：`responseVersion=current-qualified-408-v1`、`ruleVersion=current-roster-116-v9`、`assessmentVersion=enterprise-qualification-407-v2`、工作簿列/排序/四张表/计数、旧表/列/raw/审计、旧 relation/query/对应/proof ID。
- **已批准差异**：trim 类 `rddqrq/whpc/whpcyear` 差异单列于 `docs/current-qualification-typed-read-468.md`；除这些差异外，本次测试未观察到行集合、计数、分页、筛选或 T2/proof 定位差异。
- **链接**：`docs/current-qualification-typed-read-468.md`。

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

## 3. 「迁移完成」的可交付定义

「迁移完成」指 14 组都有可机械核对的落点，而不是指全部组都已切换。满足以下全部条件才可声称完成；缺一项即未完成。

### 3.1 14 组无空白

- [x] 14 组每组恰好一个顶层状态：**已切换 / 由某票承载 / 本阶段不切**；无空值、无「待定」。
- [x] 复合组（第 1、6 组）顶层仍是「由某票承载」，其子面在 §2 逐面带状态；没有把整组写成「已切换」。
- [x] 每组有 owner/稳定接缝、主要旧调用、当前实际读路径；由票承载组有票号/状态；本阶段不切组有理由+旧调用+可读边界。
- [x] 与 issue #455 原表冲突处在 §5 单列，以代码检索为准。

### 3.2 已切换组有同输入对照

- [x] 第 5 组：#320 的来源专用事实读取有 `tests/source-specific-facts-320.test.ts`、`tests/event-annual-process-read.test.ts`、`tests/platform-comparison-input.test.ts` 与 `docs/reports/real-data-320.md`；旧/新读取用同一隔离库与同一观察对照。
- [x] 第 8 组：#308/#309/#310 的版本/输入接缝有 `tests/parse-input-310.test.ts`、`tests/ocr-publication-309.test.ts`、`tests/ocr-page-lifecycle-106.test.ts`、`tests/ocr-result.test.ts`；oracle 是并发保存/删除 409、解析输入变更 409、旧输入不覆盖新结果、旧无依据 unknown。
- [x] 第 1b 子面：#455 slice 2 的 `tests/enterprise-detail-typed-read-455.test.ts`（行集合、ID、typed null 不回填、冲突、HTTP 不泄露 canonical raw）与 `tests/enterprise-detail-typed-ui-455.test.ts`（typed 优先、null「未提供」、未投影回退）。
- [x] 第 6 组已切子面：#468 的 `tests/current-qualified-recognized-typed-468.test.ts` 在同一隔离 SQLite、同一观察/规则下比较 typed 与 legacy 的 `total/uncertainTotal/publishedPending`、行集合、分页、筛选、`qualificationAssessment` 与工作簿决策面；已批准 trim 差异单列。
- [x] 对照差异清单单独留档；不把新 reader 自身当唯一 oracle。未切子面没有伪称对照。

### 3.3 由某票承载组有票号/状态

| 组 | 承载票/状态 | 当前边界 |
|---|---|---|
| 1 | #455 slice 2 `3207f0e4`（已完成）；#453/#458/#462（CLOSED） | 1a/1b 已切；1c/1d 本阶段不切（见 §3.8） |
| 3 | #303 OPEN；#302 OPEN；#349–#351、#355/#356 CLOSED | 详情/来源/当前查询/工作簿部分已切；同步导出/台账/归并快照未切 |
| 4 | #306、#307 OPEN | 未开始；独立主体事实未建立 |
| 6 | #468 OPEN；`7b1164b8` | 资格见证+四消费者已切；候选 SQL 未切 |
| 7 | #311、#312 OPEN | 未开始 |
| 9 | #314 OPEN；#313 CLOSED | 未开始；阻塞已解除 |
| 10 | #315 OPEN | 未开始 |
| 11 | #321 OPEN | 未开始；依赖 #315/#303/#307 |
| 13 | #316 OPEN | 未开始 |
| 14 | #324 OPEN | 验收登记，未执行 |

### 3.4 本阶段不切组有理由+旧调用+可读边界

- 第 2 组（来源与采集/原始封套/原档）：收益低（typed 刻意不含未知键与完整原文）、风险高（会丢原始分页/冲突证据）、依赖不成立（#298/#299/#300 是修复且已 CLOSED，不是消费者切换）。旧调用与可读边界见 §2 第 2 组。
- 第 12 组（日志与配置）：独立 `.runtime-logs/events.db` + `service_credential`；并入业务读模型会破坏「清日志不清审计」。旧调用与可读边界见 §2 第 12 组。
- 第 1c/1d 子面：企业列表/对比/差异与归档/原档无承载票，且缺少同输入对照；旧调用与可读边界见 §2 第 1 组与 §3.8。
- 上述都不是只写「暂不」；后续若要切，必须另开票并补对照。

### 3.5 旧 ID 可读与每组可回退

- [x] 旧 `queryId/relationId/sequenceNo`、`record/event/evidence`、`exportBatchId/exportRowId`、`correspondenceId/proofId`、`jobId/batchId/receiptId`、文件 ID、深链全部保留。
- [x] 旧 raw、canonical、hash、sourceFingerprint、revision、审计、回执不被重写或删除。
- [x] 未投影/未映射历史明确标 `unknown/not_indexed/unverifiable`，不从当前值倒填；typed 投影 additive。
- [x] 已切组均有回退：第 5 组 `useSourceFacts=false`；第 8 组旧接口/旧输入 unknown；第 1b `typedFields=null` 回退旧字段；第 6 组 `ROSTER_RECOGNIZED_FILTER_SOURCE=legacy` 或内部 option；第 1a 旧企业详情/原档读取保留。
- [x] 回退不依赖「恢复旧 DB 抹掉新提交」；新提交/回执/审计在回退后仍可读。
- [x] 删除旧表/旧列/旧接口只在 contract 阶段、有实际停用证明与独立授权后进行；本阶段不做。

### 3.6 不把「开票」写成「已切换」

- #302/#303/#306/#307/#311/#312/#314/#315/#316/#321/#324 均 OPEN；「已登记/已开票/部分完成」不等于「已切换」。
- #468 仍 OPEN；本文件只登记「资格见证+四消费者已切、候选 SQL 未切」，**不关闭 #468**。
- 第 14 组 #324 的验收尚未执行，不能把「验收已登记」写成「验收通过」。
- 第 1c/1d 没有承载票，不能写成「由某票承载」已完成；只能写「本阶段不切」。

### 3.7 当前计数（14/14 状态非空）

| 顶层状态 | 组数 | 组 |
|---|---|---|
| 已切换 | 2 | 5、8 |
| 由某票承载 | 10 | 1、3、4、6、7、9、10、11、13、14 |
| 本阶段不切 | 2 | 2、12 |
| **合计** | **14** | — |

- 其中第 1 组是复合承载：1a/1b 已切，1c/1d 本阶段不切；第 6 组是复合承载：资格见证+四消费者已切，候选 SQL 未切（#468 OPEN）。
- 因此「已切换」整组只有 2 组；不得把复合组的已切子面累加成「14 组已切换」。

### 3.8 剩余未切清单（逐条）

| # | 旧调用（文件 + 函数/端点/页面/任务/导出/技能） | 承载票/状态 | 本阶段说明 |
|---|---|---|---|
| 1 | 企业列表：`lib/roster/enterprise-list-selection.ts:46 selectEnterpriseCoordinates`（`record`/`record_event`/`platform_export_row`/`difference_reason`）；`lib/roster/enterprise-roster.ts:601 listRosterEnterprises`；`server/api/roster/enterprises.get.ts`；`pages/index.vue` | 无切换票（1c） | 本阶段不切；先补同输入对照/另开票 |
| 2 | 对比页/对比导出：`lib/comparison-platform.ts:139 attachPlatformEvidence`（`platform_query`/`platform_relation`）；`server/api/comparison.get.ts:138`；`server/api/export.get.ts:124`；`pages/comparison.vue`；`components/ComparisonPlatformEvidence.vue` | 无切换票（1c） | 本阶段不切 |
| 3 | 差异列表：`lib/roster/difference-list.ts:20 listRosterDifferences`（`difference_reason` + `platform_query`/`platform_relation`）；`lib/roster/query-assessment.ts:34-38,182`；`server/utils/difference-read.ts:24`；`components/RosterDifferenceTable.vue` | 无切换票（1c） | 本阶段不切 |
| 4 | 归档/原档：`lib/platform/read.ts:108 listPlatformQueries`；`lib/platform/evidence-read.ts:30 readPlatformQueryEvidence`；`server/api/platform/queries.get.ts:18`；`server/api/platform/queries/[queryId]/evidence.get.ts:28`；MCP `list_platform_queries`/`get_platform_query_evidence`；`pages/platform-queries.vue:34` | 无切换票（1d/第 2 组） | 本阶段不切 |
| 5 | #302 正式事实原值/追加佐证：`server/api/roster/export.get.ts:119 allRosterEnterprises`；`lib/roster/enterprise-roster.ts:615`；`server/utils/official-evidence.ts:117`；`lib/roster/enterprise-roster.ts:981 readPublicPublishedNames` | #302 OPEN | 由票承载；未切 |
| 6 | #303 历史详情与导出：`server/api/roster/export.get.ts:119`；`lib/roster/first-recognition.ts:54`；`server/utils/record-comparison-formal.ts:40`；`components/record-correspondence/OfficialEvidence.vue` | #303 OPEN；#355/#356 CLOSED | 部分已切；历史详情/同步导出仍有旧容器原值 |
| 7 | #306 主体事实：`lib/roster/current-qualification.ts:380,439-500,660`（`difference_reason` head/`moved_in_*`）；`lib/roster/difference-list.ts:71`；`lib/roster/enterprise-roster.ts:863 movedInOf`；`components/RosterDifferenceTable.vue:150`、`RosterEnterprisePanel.vue:535`、`ComparisonReconcile.vue:181` | #306 OPEN | 未开始 |
| 8 | #307 维护页/有效查询：`server/utils/enterprise-profile.ts:43 patchEnterpriseProfile`；`server/utils/alias-maintenance.ts:74 maintainEnterpriseAlias`；`/api/roster/enterprises/:id/profile`、`/aliases/*`；MCP `patch_enterprise_profile`/`maintain_enterprise_alias`；`pages/enterprises/[id].vue`、`pages/index.vue`、`components/EnterpriseDrawer.vue` | #307 OPEN | 未开始 |
| 9 | #311 文件内容替换：`server/utils/stored-files.ts:142 scanFileStore`、`:238 backfillStoredFiles`、`:608 getStoredFile`；`server/api/files/*`；`record_evidence.source_file` 路径引用；`pages/files.vue`、`components/files/*` | #311 OPEN | 未开始 |
| 10 | #312 物理删除恢复：`server/api/files/[id].delete.ts:10,60`（默认软移出；`deleteDisk=1` 真删）；`server/api/files/[id]/restore.post.ts:27`；`server/utils/stored-files.ts:636/691/715/728` | #312 OPEN | 未开始；已删除字节当前不可恢复 |
| 11 | #314 任务中心 typed 摘要：`lib/task-center.ts:5,12 TASK_GROUPS/TASK_LABELS`；`server/utils/task-center-http.ts` 的 `json_extract`；`server/utils/job-specs.ts:36 registerJobSpecs`；`pages/tasks.vue`、`components/tasks/TaskDetail.vue` | #314 OPEN | 未开始 |
| 12 | #315 HTTP/MCP 发现模型：`server/api/roster/import/preflight.post.ts:15`、`commit.post.ts:14` 的 `defineRouteMeta`；`server/mcp/index.ts`；`server/utils/mcp-auth.ts:39 MCP_WRITE_TOOLS`；`server/utils/openapi-guard.ts` | #315 OPEN | 未开始 |
| 13 | #316 DB/缓存/索引：`db/client.ts:51-81 useDb`；`drizzle.config.ts`；`server/utils/platform-summary-cache.ts:32`；`server/utils/enterprise-read.ts:25` 单 worker | #316 OPEN | 未开始 |
| 14 | #321 技能/客户端：`.agents/skills/roster-ingestion-pipeline/SKILL.md:14,23`；`references/platform-query.md:27-51`；`references/workflow.md`、`difference-investigation.md`、`uscc-recovery.md`；`lib/roster-import-client.ts:558,647` | #321 OPEN | 未开始 |
| 15 | #324 兼容/运维：`server/utils/import-receipt-ledger.ts:19 recordImportReceipt`；`server/utils/platform-snapshots-http.ts:26`；`server/api/roster/import/replay.post.ts:27`；`DEPLOYMENT.md:33` | #324 OPEN | 验收未执行 |
| 16 | #468 候选 SQL：`lib/roster/current-candidates.ts:6 currentCandidateSql`；`lib/roster/current-workbook.ts:71,92`；`lib/roster/current-qualified-query.ts:108 currentCandidateSqlFor` | #468 OPEN | 候选未切；C04 冻结字节/hash；不关闭 #468 |

> 行号为 `3540f7fe` 静态检索结果，可能漂移；以符号名与文件内容为准。

## 4. #455 的四个 ≤M 切片状态

| 切片 | 票/PR | 状态 | 证据 | 备注 |
|---|---|---|---|---|
| 1 | #455 slice 1 / 本文件 | **已完成** | `7a56e3e3`；本文件 14 组登记 | 只登记，不写生产代码 |
| 2 | #455 slice 2 / 企业详情 | **已完成** | `3207f0e4`；`docs/platform-enterprise-detail-typed-switch.md`；`tests/enterprise-detail-typed-*-455.test.ts` | 仅 1b 企业详情的 typed 字段；1c/1d 仍未切 |
| 3 | #468 | **部分完成** | `7b1164b8`；`docs/current-qualification-typed-read-468.md`；`tests/current-qualified-recognized-typed-468.test.ts` | 资格见证+四消费者已切；候选 SQL 未切；**#468 仍 OPEN** |
| 4 | #455 slice 4 / 本提交 | **本提交完成（文档）** | 本提交；本文件 §3 完成定义 + §3.8 剩余清单 | 其余组切换或显式登记；slice 4 不写生产代码 |

- slice 1/2 已完成；slice 3 是「部分完成」，不得写成整组已切，也不得关闭 #468。
- slice 4 本提交完成；它不把 1c/1d 或 #468 候选 SQL 写成已切换。
- 四项均要求独立 PR、可单独验收；后项在前项合入后推进。

## 5. 与 issue #455 原表的校正（代码检索，2026-11-04，基线 `3540f7fe`）

| 原表/旧登记写法 | 实际（基线 `3540f7fe`） | 证据 |
|---|---|---|
| 第 2 组「#298 open；#299 #300 已关闭」 | #298/#299/#300 均 **CLOSED**；它们是修复，不是消费者切换 | `gh issue view 298/299/300` |
| 第 1 组「未切，待开」 | 1a 本地三来源查询已切（#453/#458/#462）；1b 企业详情已切（`3207f0e4`，仅 typed 字段）；1c 企业列表/对比/差异、1d 归档/原档**本阶段不切** | `docs/platform-enterprise-detail-typed-switch.md`；§2 第 1 组 |
| 第 3 组「#302；#303 open」 | #302 OPEN；#303 OPEN；#355/#356 **CLOSED**，详情/来源/当前查询/工作簿已切；同步导出/台账/归并快照仍未切 | `8a591b0f`、`b3bb4fad`；`lib/roster/enterprise-roster.ts:981,1063` |
| 第 6 组「已开票，未切」 | 已切子面：资格见证+HTTP/MCP/页面/三称号工作簿（`7b1164b8`）；未切子面：`currentCandidateSql` 候选枚举（C04 冻结）；**#468 仍 OPEN** | `tests/current-qualified-recognized-typed-468.test.ts`；`docs/current-qualification-typed-read-468.md` |
| 第 8 组「已完成」 | #308/#309/#310 CLOSED；但这是版本/输入接缝，不是平行 typed 投影 | `parse-maintenance-105.ts:17-25`；`ocr-result.ts:340` |
| 第 9 组「#314」 | #314 OPEN；其阻塞 #313 已 CLOSED | `gh issue view 313/314` |
| 第 12 组「未登记」 | 本文件登记为 **本阶段不切**，并给出边界 | §2 第 12 组 |
| 第 14 组「验收已登记」 | #324 OPEN；尚无执行回执 | `gh issue view 324` |
| 旧 §4「slice 2 待开票 / 未开始」 | `3207f0e4` **已完成**；只切 1b 企业详情，不是整组 | `docs/platform-enterprise-detail-typed-switch.md` |
| 旧 §4「slice 3 #468 OPEN/未开始」 | `7b1164b8` **部分完成**；#468 仍 OPEN，候选 SQL 未切 | `docs/current-qualification-typed-read-468.md` |
| 旧 §4「slice 4 待开票 / 未开始」 | 本提交 **完成（文档）**；形成最终登记与完成定义 | 本文件 §3/§4 |

其他状态：#468 OPEN；#302/#303/#306/#307/#311/#312/#314/#315/#316/#321/#324 OPEN；#298/#299/#300/#313/#317/#318/#319/#320/#349–#351/#355/#356/#452/#453/#457/#458/#461/#462 CLOSED/COMPLETED。

## 6. 证据来源与检索方法

### 6.1 命令（在 `3540f7fe` 工作树执行）

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

### 7.1 已运行（2026-11-04，基线 `3540f7fe`）

本提交实际运行：

```bash
pnpm vitest run tests/enterprise-detail-typed-read-455.test.ts tests/enterprise-detail-typed-ui-455.test.ts tests/current-qualified-recognized-typed-468.test.ts tests/current-qualified-408.test.ts tests/platform-recognized-projection-http.test.ts tests/platform-recognized-directory-three-way.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
```

结果：

- vitest：**6 个测试文件、117 个测试全部通过**（exit 0，7.53s）。分文件：`current-qualified-408` 87、`platform-recognized-projection-http` 12、`platform-recognized-directory-three-way` 4、`current-qualified-recognized-typed-468` 5、`enterprise-detail-typed-read-455` 6、`enterprise-detail-typed-ui-455` 3。
- `enterprise-detail-typed-ui-455` 的 stderr 是测试环境未注册 `NuxtLink` 的 Vue 警告，不是测试失败。
- `pnpm typecheck`：**exit 0**（`nuxt typecheck`）。
- 该运行只验证上述接缝的定向回归，不是 14 组迁移的 fresh 验收，也不是全量套件。

### 7.2 UNRUN / 未验证项

以下均 **UNRUN**，不得在后续报告中写成已通过：

- 未连接生产/活动 DB、WAL、原始文件或生产服务；未做真实副本影子对照。
- 未做桌面与 390px 页面实操/像素断言；未做真实浏览器布局验收。
- 未做异步导出下载后的独立工作簿解析重跑；未跑完整 HTTP/MCP 组合、任务/导出组合。
- 未跑全量套件、`build`、性能对照或 CI。
- 未验证 PostgreSQL、部署、回滚或备份恢复；#324 的执行回执不存在。
- 未验证 #468 候选 SQL 的等价性；C04 仍冻结 `currentCandidateSql` 字节/hash，本文件只登记未切，不关闭 #468。
- 未验证 #302/#303、#306/#307、#311/#312、#314、#315、#316、#321、#324 的剩余面；也未验证 1c/1d 的旧/新对照。
- 本文件引用的行号是 `3540f7fe` 的静态位置；后续提交可能漂移，复核时以文件内容为准。
