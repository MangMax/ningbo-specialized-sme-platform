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

## 下一层读接口接缝

共享写回 DTO 位于 `lib/platform/business-record.ts`，领域入口位于 `server/utils/platform-business-record.ts`。下一层应先按企业、queryIds、sourceSet、asOf 限定原观察，再 LEFT JOIN mapping/version/record，输出观察来源和旧决定引用。未索引为 not_indexed；missing_key、conflict、unverifiable 以原 relationId 隔离，不把所有 null 合成一组。不同版本/接口/角色不能折叠；相同版本的多个出处都要保留。不得用同 record 的其他观察代替选定来源的 proof 或复制旧裁决。

本层没有更改 UI、候选、企业详情或 record comparison 消费者，因此旧页面仍会展示重复采集；共享业务读模型、冲突聚合、消费者接入、生产历史投影与父 #243 验收留待下一层。没有生产数据库迁移/写入或全用户需求完成声明。
