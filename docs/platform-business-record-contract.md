# 平台业务记录、内容版本与采集观察（#244）

本层在原归档之外增加身份投影，不改旧表、旧 ID、对应、差异、别名、审计及其指纹。ADR 见 [平台业务记录身份](adr/2026-10-23-platform-business-record-identity.md)。三个接口 `business_list` / `apply_list` / `recognized_list` 各自以真实 `id` 建身份；recognized 的 UUID 不与 SQ 编号或其他接口合并，原 collectionEvidence 校验仍然执行。

## 存储与规则

- `platform_business_record`：唯一 `(interface,platform_key)`，仅去编号首尾空白，大小写及前导零保留。不按企业名称、USCC、称号、query scope 或 raw hash 猜身份。
- `platform_business_record_version`：唯一 `(record_id,hash_algorithm,content_hash)`。算法为 `platform-row-json-v1`，SHA-256 输入为该标识、换行和完整 rawFields 的确定性 JSON；递归排序对象键，数组保序，保留值类型、null、缺键及所有未知字段。哈希命中还核对 canonicalRawJson，字节不等整批回滚。标准化列、查询/采集元数据、企业归属和 sourceText 包装不进入版本。
- `platform_business_observation`：主键为原 relationId，recordId/versionId 可空；版本与 record 有复合外键，旧观察和内容均 RESTRICT 删除。记录投影规则、源输入指纹、索引时间及 import batch，索引时间不代表采集或业务生效时间。没有可覆盖的 currentVersionId；A→B→A 是两种内容、三次观察。

`identityState=resolved|missing_key|conflict`。relationKey 与 raw.id 同时有效且不同为 conflict，保留旧观察但不挂 record。历史空 relationKey 可由真实 raw.id 投影，不回写旧列；无有效字符串编号时两 ID 均空，每条观察保持独立。`keySource=relation_key|raw_id|both|none`。

`contentState=verified|unverifiable`。无 raw、非法 JSON、非对象及空对象不从标准化列补造版本，versionId 为 null。verified 表示按归档的完整 raw 行比较；调用方必须提交真实完整业务行，不能以七字段投影或截断内容冒充原文。投影不能证明上游归档自身的完整性，也不会通过事后网络查询重建历史。缺编号/键冲突不能建立可复用版本。

投影输入指纹包含接口、原 query/sequence/查询条件/时点、relationKey 和 raw；JSON 对象重排键等价。源输入改变报 `projection_source_drift`，不静默重映射。企业核验、标准化列等非投影依赖字段不进入此指纹。新增映射不进入旧 record correspondence 的 sourceFingerprint。

新采集和 existing-skip 均在原统一导入事务内调用 `ensurePlatformObservation`。同 query 身份/sequence 的 key 或 raw 不同报 `observation_payload_conflict`；同批不同输入也在预检拒绝。完全相同重放保留原观察，真实新采集需新的 queriedAt。

## 统一历史投影

继续使用 REST `POST /api/roster/import/preflight`、`/commit` 和 MCP `preflight_roster_batch`、`save_roster_batch`：

```json
{
  "idempotencyKey": "platform-identity/history/1076-3161/v1",
  "sourceKind": "platform_archive",
  "sourceIdentity": "archived-platform-relations/1076-3161",
  "payload": {
    "platformRecordObservations": [{"relationId": 1076}, {"relationId": 3161}]
  }
}
```

新字段每批 1..100 项，ID 为互不重复的正安全整数，项内只允许 relationId。不接收客户端 raw/hash/recordId/versionId；服务按 ID 读原观察，复用相同 planner/ensure。历史字段只允许 sourceKind=platform_archive，该 sourceKind 不允许空命令。REST 与 MCP 均拒绝 null、非数组、空数组、重复 ID、额外字段及超限请求。无单独直写或迁移命令。

预检不写业务表，但沿用 import_batch/import_receipt 记账；返回 `preflight.canonicalProjection` 及服务器读取的 `platformObservationSources` 指纹。commit 不接收客户端计划哈希，重读原观察并校验同键预检保存的指纹及既有映射。源缺失报 `projection_source_missing`，预检后或映射后源漂移报 `projection_source_drift`，整批不写。

原 import 事务同时提交原归档、新投影、批次与最终回执。完全相同幂等键/请求重试返回原 committed 回执；历史投影同键异请求始终 409（预检或失败后也不能用另一份命令抹掉冻结的源输入）。失败可用原请求/原键恢复；确需接受已变化的未索引源，使用新键重新预检。已有映射发生漂移仍拒绝，需另走显式证据修正设计。本层不引入修正旁路。

回执沿用 `/api/roster/import/receipts` 及对应 MCP 读工具。`items[].detail.canonicalProjection` 返回逐观察的 relationId/recordId/versionId/状态、规则、指纹和 created 布尔值；不回传 raw。`summary.canonicalProjection` 单独统计 recordsCreated、versionsCreated、observationsCreated、observationsReused、missingKey、conflict、unverifiable。旧 summary.written/rowsWritten 仍只计旧实体/查询/关系等新增行，历史投影为 0。相同键重试返回原计数；新键重新投影返回新操作的 reused 计数。`/replay` 仍只做既有公布文件出处收敛，不承担平台投影恢复。

## apply_list 来源专用 typed 投影（#452）

`apply_list`（上游 `queryList`）在共享身份/版本/观察之外新增 `platform_apply_projection`，一内容版本一行，关联 `platform_business_record_version.id` 与 `platform_business_record.id`。复合外键 `(version_id, record_id)` 保证版本归属一致；`ON DELETE RESTRICT` 保留历史引用。

投影字段只来自归档原行的真实来源语义：`sblx` → `declare_kind`（已知 申请/更新/复核 沿用既有字典归一为 apply/update/review，字典外原值去首尾空白后保留）、显式 `year` → `declaration_year`（JSON 整数或十进制整数字符串；缺失/空白/布尔/小数/非数字为 null）、`sqsj` → `applied_at`、`cszt` → `status`、`qymc` → `name_raw`、`tyshxydm` → `uscc_raw`。不从 `sqsj`/`queriedAt`/`batch` 推年，不推称号，不跨接口合并。

规则版本 `platform-apply-v1`。`ensurePlatformObservation` 在同一导入事务内为 resolved+verified 的 `apply_list` 观察建立或核对投影；缺编号、编号冲突、原文不可核实的观察不建投影，仍以原 relationId 隔离。同内容版本出现不同投影整批以 `apply_projection_conflict` 拒绝，不静默重解释历史内容。

迁移 `0033_platform_apply_projection` 只新增该表与索引，不重建既有表。历史观察继续走 `platformRecordObservations`（每批 1..100）投影；预检返回 `canonicalProjection[].applyProjection` 计划，提交回执的 `canonicalProjection` 增加 `applyProjectionsCreated`/`applyProjectionsReused`（仅当批次包含 apply 投影时出现）。旧 query/relation/raw/hash/version/observation/对应/审计/深链均不改写。

本投影是分域扩展新增的第 53 张应用表；ADR 的 52 表是 #297 的审计基线，不是本轮重审结论。HTTP/MCP 本地申报查询与页面属于 #453，不在本层实施。

## business_list 来源专用 typed 投影（#457）

`business_list`（上游 `businessList`，关联办理）在共享身份/版本/观察之外新增 `platform_business_projection`，一内容版本一行，关联 `platform_business_record_version.id` 与 `platform_business_record.id`。复合外键 `(version_id, record_id)` 保证版本归属一致；`ON DELETE RESTRICT` 保留历史引用。

投影字段只来自归档原行的真实来源语义：`id` 仍是既有 `platform_business_record.platform_key`（办理编号）；`sblx` → `declare_kind`（已知 申请/更新/复核 归一为 apply/update/review，字典外原值去首尾空白后保留）、显式 `year` → `business_year`（JSON 整数或十进制整数字符串；缺失/空白/布尔/小数/非数字为 null）、`sqsj` → `applied_at`、`cszt` → `status`、`whpc` → `batch`、`personuuid` → `award_batch_label`（原认定批次标签，不是人员身份）、`szsfmc` → `province`、`qymc` → `name_raw`、`tyshxydm` → `uscc_raw`。不从 `sqsj`/`queriedAt`/批次/名称推年份、称号或状态。

称号只是查询的明确范围（`platform_query.rdjb` / `platform_query_title_scope`），属于查询事实，不写入内容版本、不当作逐行称号事实；同一内容版本在不同查询称号范围下不产生不同的 typed 行或伪版本。同编号跨接口（`apply_list`/`business_list`/`recognized_list`）仍按 `(interface, platform_key)` 分离，不自动合并，也不生成有源关联或对应决定。

规则版本 `platform-business-v1`。`ensurePlatformObservation` 在同一导入事务内为 resolved+verified 的 `business_list` 观察建立或核对投影；缺编号、编号冲突、原文不可核实的观察不建投影，仍以原 relationId 隔离。同内容版本出现不同投影整批以 `business_projection_conflict` 拒绝，不静默重解释历史内容。

迁移 `0034_platform_business_projection` 只新增该表与索引，不重建既有表。历史观察继续走 `platformRecordObservations`（每批 1..100）投影；预检返回 `canonicalProjection[].businessProjection` 计划，提交回执的 `canonicalProjection` 增加 `businessProjectionsCreated`/`businessProjectionsReused`（仅当批次包含 business 投影时出现）。旧 query/relation/raw/hash/version/observation/对应/审计/深链均不改写；`apply_list` 的既有投影与回执字段不变。

本投影是分域扩展新增的第 54 张应用表；ADR 的 52 表是 #297 的审计基线，不是本轮重审结论。HTTP/MCP 本地关联办理查询、页面与真实消费者对照属于 #458，见 [关联办理本地查询](platform-business-processes.md)：详情按观察返回其自己的对应决定引用（id/status/revision），不复制决定内容、不传播到其他观察。

## recognized_list 来源专用 typed 投影（#461）

`recognized_list`（上游 `queryBusList`，平台认定目录）在共享身份/版本/观察之外新增 `platform_recognized_projection`，一内容版本一行，关联 `platform_business_record_version.id` 与 `platform_business_record.id`。复合外键 `(version_id, record_id)` 保证版本归属一致；`ON DELETE RESTRICT` 保留历史引用。

投影字段只来自归档原行的真实来源语义，文本字段只去除首尾空白：`id` 仍是既有 `platform_business_record.platform_key`（目录业务编号）；`rddqrq` → `validity_date_raw`（有效期/失效日期**原值**逐字保留，精度与格式不改写、不截断、不解析成日期或年份）；`whpcyear` → `maintenance_year`（仅显式正整数：JSON 整数或十进制整数字符串；缺失/空白/布尔/小数/负数/非数字为 null）；`whpc` → `maintenance_batch`；`szq` → `district`（返回行原值，不是查询筛选码）；`rdxx` → `award_note`；行级 `rdjb` → `title_raw`（平台称号原值，不归一化）；`qymc`/`tyshxydm` → `name_raw`/`uscc_raw`。缺值保留 null，不从查询条件、`queriedAt`、批次或名称猜填；也不从 `rddqrq`/`whpc` 推造维护年份。

称号仍只作为原查询的显式范围（`platform_query.rdjb` / `platform_query_title_scope`）表达，是查询事实，不写入内容版本。若原行确实带 `rdjb`，只按原值保存为 `title_raw`；读路径必须与查询范围分开显示，不一致时沿用既有冲突名 `title_conflict`（见 `server/utils/platform-business-detail-read.ts`），不新增冲突名，也不把查询范围升格为逐行称号事实或把行值写回查询。

规则版本 `platform-recognized-v1`。`ensurePlatformObservation` 在同一导入事务内为 resolved+verified 的 `recognized_list` 观察幂等建立或核对投影；`apply_list`/`business_list` 既有投影行为与回执完全不变。缺编号、编号冲突、原文不可核实的观察不建立可复用 typed 行，仍以原 relationId 隔离；同内容版本出现不同投影整批以 `recognized_projection_conflict` 拒绝并回滚，不静默重解释历史内容。同编号跨接口（`apply_list`/`business_list`/`recognized_list`）仍按 `(interface, platform_key)` 分离，不自动合并。

迁移 `0035_platform_recognized_projection` 只新增该表与索引，不重建既有表。历史观察继续走 `platformRecordObservations`（每批 1..100）投影；预检返回 `canonicalProjection[].recognizedProjection` 计划，提交回执的 `canonicalProjection` 增加 `recognizedProjectionsCreated`/`recognizedProjectionsReused`（仅当批次包含 recognized 投影时出现）。旧 query/relation/raw/hash/version/observation/对应/审计/深链均不改写；`apply_list` 与 `business_list` 的既有投影及回执字段不变。

本投影是分域扩展新增的第 55 张应用表；ADR 的 52 表是 #297 的审计基线，不是本轮重审结论。本层只保存目录原行事实，**不决定当前正式资格**：缺少或不同的目录行本身不会使称号失效，正式资格/事件/当前有效企业结果仍来自正式公布事实与既有资格读取。HTTP/MCP 目录读路径、页面与真实消费者对照属于 #462，不在本层实施。

## 下一层读接口接缝

共享写回 DTO 位于 `lib/platform/business-record.ts`，领域入口位于 `server/utils/platform-business-record.ts`。下一层应先按企业、queryIds、sourceSet、asOf 限定原观察，再 LEFT JOIN mapping/version/record，输出观察来源和旧决定引用。未索引为 not_indexed；missing_key、conflict、unverifiable 以原 relationId 隔离，不把所有 null 合成一组。不同版本/接口/角色不能折叠；相同版本的多个出处都要保留。不得用同 record 的其他观察代替选定来源的 proof 或复制旧裁决。

## 共享 scoped 读模型与候选（#246 第一项）

公共读 DTO 在 `lib/platform/business-record.ts`；共享入口在 `server/utils/platform-business-record-read.ts`：

- `readPlatformBusinessMetadata(db, relationIds)` 仅对指定原 relationId LEFT JOIN observation/record/version 的轻量列，返回 Map。缺映射仍保留原 relationId；不读取完整 raw 或 canonicalRawJson。
- `readPlatformBusinessGroups(db, observations)` 的输入是**已经按调用方 query/time/owner/title/role 及原业务条件筛选的观察**。调用方负责同一个读事务快照。模块不发现额外查询，不读取同 record 的全档观察。每批至多 400 个 ID/参数；空输入不查表。
- 分组键包含目标 event/enterprise/title、type、role、接口和 recordId+versionId。仅 resolved+verified 可共享候选组。not_indexed、missing_key、conflict、unverifiable 均以 relationId 隔离；不会把全部 null 或同 record 的未知内容归并。
- 返回 `businessRecord`（recordId/versionId/interface/platformKey/状态/规则/内容哈希）、`representativeRelationId`、全部 `observationRefs`、`existingCorrespondenceIds`、`existingCorrespondences`、冲突并集。每条 observation 保留自己的 relation/query/sequence/time、查询条件/状态、原主体/称号/核验字段、证据与 normalizationConflicts，以及自己的旧决定。旧决定保留目标/type/role/status/revision/ruleId/ruleVersion/决定时间，不读取大 provenance。
- 代表观察按 relationId 排序，优先有任何既有对应端点的最小 ID，否则最小原 ID；不会优先 confirmed。组内相同 type/role 的相反决定或不同目标决定报 `correspondence_decision_conflict`，全部决定仍可见。身份、称号与原标准化冲突只增加或保留，不自动覆盖事实、复制决定或重写指针。

REST `POST /api/roster/correspondences/candidates` 与 MCP `find_record_correspondence_candidates` 复用既有同域服务。先执行既有选源、成功/partial、有效 USCC、企业归属、称号、event/later-process 角色条件，再调用共享分组。候选仍始终 `status=candidate`；顶层 `evidence` 为代表观察原证据，全组证据见 `observationRefs[].evidence`。`existingCorrespondenceId/revision` 仅指代表端点上匹配目标/type/role的旧对应；组级数组中的确认不代表每条观察都已确认。只选新 query 时不会借未选旧 query 的决定证明已对应，不提供全档提示。

`multiple_candidate_rows` 仅在实际平台业务版本候选组多于一个时加入，重复观察不构成多候选；不同版本/接口/角色仍独立。导出候选维持原行粒度、证据和既有对应语义。`total/page/pageSize` 在平台分组后与导出行合并计算；查询覆盖及导出批次仍按原来源返回。原候选入口不支持 `asOf`，本项不新增它；未来详情/comparison 应先按自己的时间/来源契约过滤再使用共享读模块。

本项不接入企业详情 UI 或 record comparison（#246 其余两项），不改 PR245 的存储写入、原归档列表、旧指纹、裁决、差异引用，也不执行生产迁移/写入。业务版本候选去重不表示已完成全用户需求或全档数据验收。
