# #102 差异决定生命周期、历史与旧标注预览

范围：差异决定的显式替代/撤回、精确读回及有界历史；旧人工标注只读映射/冲突预览。没有生产资料迁移、自动判因、改名、部署、main 合并或 UI 重建。本票不提供删除来源/旧决定的接口。

## 公开契约

REST 与 MCP 调用同一个 `decision-lifecycle-102` 应用服务；`/_openapi.json` 声明当前 HTTP 字段，MCP `tools/list` 声明工具参数。

- `POST /api/roster/decision-lifecycle/commands` ↔ `save_difference_decision`：单命令、单事务追加版本。REST 使用 `NUXT_API_TOKEN`（Bearer 或 X-API-Token）；MCP 使用独立的 `NUXT_MCP_TOKEN`。未配置、缺失、错误 token 均关闭写入。无 token 的 MCP 工具发现不列出写工具。
- `GET /api/roster/decision-lifecycle/{id}` ↔ `get_difference_decision`：稳定版本 ID 精确读取，含完整依据、原因说明和元数据，不包含平台原文。
- `GET /api/roster/decision-lifecycle/current?enterpriseId=…&titleCode=…&direction=…` ↔ `get_current_difference_decision`：读取 `versionId` 和 `current`。无版本时两者均 null；撤回后 `versionId` 指向撤回标记、`current=null`。
- `GET /api/roster/decision-lifecycle/history` ↔ `list_difference_decision_history`：给 `id`，或完整企业/称号/方向；不能混用两种范围。`page=1..1000000`，`pageSize=1..50`，默认 1/50。按 `recordedAt DESC,id DESC`，同事务返回 rows/total/page/pageSize。摘要省略 basis、reasonNote、measureNote、迁入细节和原始大字段，`detailsAvailable=true` 指引按 id 取完整版本。
- `GET /api/roster/decision-lifecycle/legacy-preview` ↔ `preview_legacy_difference_decisions`：可给精确 `legacyKey`，或同样有界分页；只读服务端配置的旧 JSON，不接受任意路径。

所有新 HTTP 响应和 MCP 响应均为 no-store；不新增当前结果缓存。已热读当前、旧差异列表和企业详情后，提交必须立即读回新版本。平台摘要缓存没有新增失效责任，因为本命令不修改平台查询；既有 SQLite commit observer 机制保留。

### 命令形状

```json
{
  "enterpriseId": 123,
  "titleCode": "specialized_sme",
  "direction": "missing_in_miit",
  "action": "replace",
  "expectedCurrentId": 456,
  "idempotencyKey": "review/explicit-102-example",
  "actor": { "type": "agent", "id": "reviewer-id" },
  "basis": "明确列出人工核对的依据及来源定位",
  "ruleVersion": "manual-review-1",
  "effectiveAt": "2026-10-19T00:00:00Z",
  "decision": {
    "status": "needs_review",
    "measureCode": "manual_review",
    "verificationStatus": "pending",
    "reasonCode": null,
    "reasonNote": null,
    "evidenceQueryId": null,
    "evidenceRelationId": null
  }
}
```

首次无决定时 `expectedCurrentId=null`。后续必须使用当前查询的 **versionId**，包括已撤回坐标；不能把回执的 `currentId=null` 当成没有历史。`replace` 是完整新解释：未给的可选原因/证据/迁入字段设为 null，不隐式继承旧解释。`withdraw` 使用相同元数据，但必须省略整个 `decision`。重复撤回没有活动决定的坐标返回 409。

actor 必须给 type=user/agent 和非空 id；沿用单机 token 授权模型，actor 是显式操作者声明。idempotencyKey/actor.id/ruleVersion 最多 200 字符；basis、各说明和迁入城市最多 4000 字符，非空值会 trim。effectiveAt 必须为含时区的 ISO 时间，是业务时点；createdAt 是实际写入时点；recordedAt 是兼容旧读模型的单调登记排序键。旧导入可使用无毫秒/带偏移或未来时间，追加排序键会越过旧值，不把业务时点改成“现在”。无法解析的旧登记时点返回 422，要求明确核对，绝不悄悄覆盖。

`confirmed_reason` 必须有 reasonCode 且 verificationStatus=confirmed；`confirmed_no_diff` 要求无 reasonCode、measureCode=none、verificationStatus=confirmed；pending_review 必须配 confirmed_reason/confirmed/follow_review。其他原因的默认措施沿用原契约的建议性质，不强制重新判因。measureCode 只记录措施，不执行改名或身份修改。来源指针可空（basis 可引用其他明确依据）；给平台指针时验证存在、企业归属、查询一致性和称号范围，多称号行仅取原分页元数据定位，不读取原始响应数组。

回执为 `{versionId,currentId,previousId,action,recordedAt}`。同一归一化请求和幂等键跨传输重放返回原回执，即使当前已被后续决定替代；回执描述**当次**结果，最新状态请读 current。同键异请求 409 idempotency_conflict；预期版本不符 409 stale_version。读不到企业/版本 404；非法字段/组合 400；证据错误 422；事务失败 500 transaction_failed。MCP 业务失败为 isError=true，text 是相同 `{error:{code,message}}` JSON；原始 RPC 参数在 toolkit 去掉未知键之前严格验证，非法参数为 HTTP 400/-32602。错误不泄露 SQL、内部故障文本或凭据。

## 追加历史与兼容

迁移 `0018_decision_lifecycle_102.sql` 只增加 nullable 元数据列、自引用 previous_id、命令幂等唯一索引和已接管坐标的部分索引，不回填旧业务行。已有 `difference_reason_version_uq` 足以支持范围倒序历史，不新增重复排序索引。

每次替代/撤回均新增 difference_reason 行，旧原因、依据、平台查询及关系不修改。撤回行 lifecycleAction=withdraw，兼容旧差异/详情投影的状态为 not_queried、原因清空；新 current API 明确返回 current=null。`isCurrent` 表示最新**版本**（包括撤回标记），不是有效结论的布尔值。

- 已有正式旧导入行读为 origin=legacy_import，原 ID 和原说明保留，不伪造操作者/规则。新命令经 expectedCurrentId 显式接管坐标。
- 接管前，旧统一导入 payload.differences 保持历史兼容；接管后，旧导入 preflight/commit 的该项返回 decision_lifecycle_required，并让整批业务写入失败。计划和事务执行阶段各复核一次，避免计划后被接管的竞态。已提交旧导入回执仍可重放，不重复写入。
- `PATCH /api/comparison/curated` 已停用，返回 410 legacy_write_retired、replacement 和 preview 路径；不改 JSON 或正式决定。旧比较 GET/导出仍可只读展示历史标注，不能把 curated=true 当成 confirmed_no_diff。历史 helper 仅保留格式/读取回归用途，应用没有继续写旧 JSON 的公开入口。
- 预览按 JSON 元组中的精确统代或 `name:` 后的 name_norm 查索引，最多两个候选；同名歧义不选企业。始终返回 equivalentToConfirmedNoDiff=false、migrationApplied=false 和 legacy_not_equivalent；标明未匹配、歧义、坏键、坏标注、已有正式决定/撤回。没有映射自动应用操作。
- 旧文件实际读取上限 2 MiB/10000 键；摘要说明每字段最多 4000 字符，发生截取会显式标 legacy_summary_truncated。预览响应超过 256 KiB 返回 413，要求更小页或精确键；不以截断整个清单假装完整。坏 JSON 返回 422。生产旧资料迁移必须另行授权。

## 验收证据

`tests/decision-lifecycle-102-http.test.ts` 使用真实 Nuxt HTTP 与 MCP tools/call、隔离 SQLite、独立构建目录和动态保留端口；没有 mock 自有应用服务。测试最大 worker 数为 1，故障 trigger 仅在临时库作为输入注入。

1. 明确依据/操作者/规则/业务时点与稳定 ID：`appends a version with explicit actor basis rule and business time and reads it by stable ID`。
2. 替代、撤回、保留旧原因、分页、跨传输幂等及旧回执不会复活结论：`replaces then withdraws without resurfacing old reasons and pages immutable history across transports`。
3. 缺鉴权、独立凭据、非法字段/状态、精确不存在/非法分页：`rejects absent or wrong transport auth and malformed decisions without changing current state`。
4. 并发预期版本、同键异请求、插入后故障回滚/恢复、热读后的当前/列表/详情更新及原始平台响应不变：`serializes competing expected versions, rejects key reuse, and rolls back an injected post-insert failure`。
5. 可核对旧映射、歧义和冲突，不自动升级/迁移，旧 PATCH 410 且旧文件字节不变：`previews exact legacy mappings and conflicts without promoting reviewed annotations or modifying either store`。
6. 旧正式决定可查、无毫秒未来时点可接管、接管后旧导入不能覆盖：`keeps legacy imports readable but requires lifecycle commands after explicit adoption`。
7. 证据企业/称号错误拒绝、严格 RPC 参数、MCP stale/rollback 错误不泄漏 SQL：`rejects mismatched evidence and gives typed MCP failures without leaking internal SQL`。
8. OpenAPI 必填/动作、MCP 只读发现、单独无 token 进程关闭两种写入口：`discovers full HTTP and MCP contracts and disables writes when tokens are unconfigured`。
9. 计划后接管的执行期检查与整批回滚：`rechecks lifecycle ownership inside legacy import execution and rolls back the whole batch`。
10. 有界历史、精确长说明、不加载无关原文、索引计划、旧文件/响应上限和坏 JSON：`bounds scoped history and legacy preview while unrelated large raw evidence is never materialized`。

红绿日志在 `/tmp/ningbo-spec98/ticket-102/`：red-1..8 对应首次能力缺失、撤回、状态组合、旧预览/旧导入、历史大说明、证据/MCP 错误、契约发现和执行期竞态；green-1..8 保存修复后的干净结果。red-8 先修正了故障 trigger 不支持绑定变量的夹具错误，再重新得到 committed≠failed 的业务红灯。`final-candidate-tests.log` 为 7 文件 **212/212 通过**；包含 curation、MCP auth、统一导入、平台比较、企业读模型和差异筛选回归。最终提交绑定结果见下方。

## 性能范围与集成提示

有界性样本为确定性合成数据：200 条同坐标历史，每条原因说明 42000 UTF-8 字节；一条无关 7600000 字节平台原文和无效 collection_evidence JSON 哨兵。第二页 50 条历史摘要低于 256 KiB；详情完整取回长说明；MCP 旧差异列表不解析无关 JSON；EXPLAIN 使用既有 difference_reason_version_uq 的范围索引，无临时排序。该测试验证投影/范围/返回体与不解析无关大字段，**不是延迟或容量基准**，没有 p95/p99、2x/5x、受控容器或长期负载验收声明。未运行重型 benchmark，不与父代理的基线/候选测量争用。

新当前/精确读取按键；历史在 SQL 中 count/limit/offset；命令幂等按唯一索引；已接管判断使用部分索引；预览只在文件上限内解析键，对页内候选逐个精确查找。旧 MCP list_differences 改为 SQL 最新版本/分页和查询元数据投影，保留原 rows/counts 形状，消除其先前全量读取平台原档的路径。深页 OFFSET 仍随范围页深增加 SQL 扫描，未宣称常数耗时。

共享改动仅为 db/schema.ts、迁移 journal、server/utils/roster-import.ts 的接管守卫、mcp-auth 写名单、mcp-roster 差异摘要读取、MCP 中间件/说明，以及停用旧 PATCH；对应回归测试同步调整。迁移按预留 0018，未生成无关 snapshot；父集成合并其他预留迁移时需整理 journal 顺序。没有修改共享 GLOSSARY 或其他票据文档。
