# #102 差异决定生命周期、历史与旧标注预览

## R1：身份归并与生命周期历史

旧归并的内容去重仅适用于未纳管解释。源企业已有任何生命周期版本（含撤回）时，当前入口不支持保持原企业范围、命令哈希与原回执的迁移，预检和事务内执行均返回逐项 `merge_difference_lifecycle_conflict`，列明版本 ID、企业、称号及方向。目标已接管的同称号×方向也不能接收源企业旧解释，即使登记时点不同。不会隐式转换、重挂或删除任何已纳管历史。

目标其他坐标已接管不阻止未纳管坐标的原有去重/迁移；旧版未纳管归并行为保留。执行期新增接管会令整批回滚，失败导入回执在消除竞态后重试成功仍按原 ID 可查。真实 HTTP 验证见 `tests/decision-lifecycle-102-http.test.ts` 中 `rejects identity merges affecting lifecycle history`、`rolls back an execution-time managed merge collision and retains the failed receipt after safe retry`、`keeps legacy merge deduplication and reassignment compatible outside the adopted target coordinate`。R1 日志在 `/tmp/ningbo-spec98/fix-r1/merge-lifecycle-red-confirmed.log`（5 项业务红测）与 `merge-compat-green.log`（3 文件 148 项通过）；最终提交与验证边界见同目录 handoff。

范围：差异决定的显式替代/撤回、精确读回及有界历史；旧人工标注只读映射/冲突预览。没有生产资料迁移、自动判因、改名、部署、main 合并或 UI 重建。本票不提供删除来源/旧决定的接口。

## 公开契约

REST 与 MCP 调用同一个 `decision-lifecycle-102` 应用服务；`/_openapi.json` 声明当前 HTTP 字段，MCP `tools/list` 声明工具参数。

现行复核增量见 [#114：Review completion through existing #102](evidence-review-contract-114.md#review-completion-through-existing-102)：复核沿用本页的 HTTP/MCP 命令入口与应用服务，增加 `maintain` 和 `reviewedEvidence`，不另建通用写入入口。下方历史验收和交接记录仍对应各自当时的候选，不代表后继契约已在本次文档修订中通过运行验收。

- `POST /api/roster/decision-lifecycle/commands` ↔ `save_difference_decision`：单命令、单事务；`replace`/`withdraw` 追加版本，`maintain` 保留原版本并记录复核基线和回执。REST 使用 `NUXT_API_TOKEN`（Bearer 或 X-API-Token）；MCP 使用独立的 `NUXT_MCP_TOKEN`。未配置、缺失、错误 token 均关闭写入。无 token 的 MCP 工具发现不列出写工具。
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

上述 JSON 是 `replace` 示例。按 [#114 复核完成契约](evidence-review-contract-114.md#review-completion-through-existing-102)，三种动作的增量约束如下：

- `maintain` 必须省略 `decision`，必须提供 `reviewedEvidence`；保留原版本、原因、措施、证据及原审计信息，只显式记录本次复核基线和回执。已撤回、历史或已归并主体的决定不能执行维持。
- `replace` 必须提供完整 `decision`，可选提供 `reviewedEvidence`；带已审证据时，在同一事务中完成替代和复核。
- `withdraw` 必须同时省略 `decision` 和 `reviewedEvidence`。

`reviewedEvidence` 为严格对象 `{latestRevisionId, projectionReady:true}`，`latestRevisionId` 为 0 至 `Number.MAX_SAFE_INTEGER` 的整数。HTTP/MCP 仍须提供精确企业/称号/方向、`expectedCurrentId`、`idempotencyKey`、`actor`、`basis`、`ruleVersion`、`effectiveAt`。复核在既有 immediate 事务内核对当前决定、最新相关已提交证据修订及投影就绪状态；证据已变化或投影未完成返回 `409 stale_evidence`，冲突后需重新读取详情。没有复核基线仍是 unknown，不视为 valid。

复核完成回执保留原 `{versionId,currentId,previousId,action,recordedAt}` 并增加 `reviewedRevisionId`。同键同请求在并发检查前返回原回执，不写入，也不能清除后来证据带来的待核状态；同键异请求仍为 `409 idempotency_conflict`，当前决定变化仍为 `409 stale_version`。旧回执与原幂等语义保留；详细复核语义以后继 #114 契约为准。对旧版本显式 `maintain` 会通过复核回执接管该坐标，既有导入、旧标注和受管身份归并守卫继续生效，不自动迁移旧解释。

actor 必须给 type=user/agent 和非空 id；沿用单机 token 授权模型，actor 是显式操作者声明。idempotencyKey/actor.id/ruleVersion 最多 200 字符；basis、各说明和迁入城市最多 4000 字符，非空值会 trim。effectiveAt 必须为含时区的 ISO 时间，是业务时点；createdAt 是实际写入时点；recordedAt 是兼容旧读模型的单调登记排序键。旧导入可使用无毫秒/带偏移或未来时间，追加排序键会越过旧值，不把业务时点改成“现在”。无法解析的旧登记时点返回 422，要求明确核对，绝不悄悄覆盖。

`confirmed_reason` 必须有 reasonCode 且 verificationStatus=confirmed；`confirmed_no_diff` 要求无 reasonCode、measureCode=none、verificationStatus=confirmed；pending_review 必须配 confirmed_reason/confirmed/follow_review。其他原因的默认措施沿用原契约的建议性质，不强制重新判因。measureCode 只记录措施，不执行改名或身份修改。来源指针可空（basis 可引用其他明确依据）；给平台指针时验证存在、企业归属、查询一致性和称号范围，多称号行仅取原分页元数据定位，不读取原始响应数组。

回执为 `{versionId,currentId,previousId,action,recordedAt}`。同一归一化请求和幂等键跨传输重放返回原回执，即使当前已被后续决定替代；回执描述**当次**结果，最新状态请读 current。同键异请求 409 idempotency_conflict；预期版本不符 409 stale_version。读不到企业/版本 404；非法字段/组合 400；证据错误 422；事务失败 500 transaction_failed。MCP 业务失败为 isError=true，text 是相同 `{error:{code,message}}` JSON；原始 RPC 参数在 toolkit 去掉未知键之前严格验证，非法参数为 HTTP 400/-32602。错误不泄露 SQL、内部故障文本或凭据。

## 追加历史与兼容

迁移 `0018_decision_lifecycle_102.sql` 只增加 nullable 元数据列、自引用 previous_id、命令幂等唯一索引和已接管坐标的部分索引，不回填旧业务行。已有 `difference_reason_version_uq` 足以支持范围倒序历史，不新增重复排序索引。

每次替代/撤回均新增 difference_reason 行，旧原因、依据、平台查询及关系不修改。撤回行 lifecycleAction=withdraw，兼容旧差异/详情投影的状态为 not_queried、原因清空；新 current API 明确返回 current=null。`isCurrent` 表示最新**版本**（包括撤回标记），不是有效结论的布尔值。

- 已有正式旧导入行读为 origin=legacy_import，原 ID 和原说明保留，不伪造操作者/规则。新命令经 expectedCurrentId 显式接管坐标。
- 接管前，旧统一导入 payload.differences 保持历史兼容；接管后，旧导入 preflight/commit 的该项返回 decision_lifecycle_required，并让整批业务写入失败。计划和事务执行阶段各复核一次，避免计划后被接管的竞态。已提交旧导入回执仍可重放，不重复写入。
- `PATCH /api/comparison/curated` 保留旧客户端兼容：未显式接管的坐标仍按原载荷写 JSON，成功只返回 `{curated:boolean}`；note 省略保留旧值，空串清空，curated=false 取消。标注不生成正式决定，不等同 confirmed_no_diff；无匹配的精确键保留原 JSON-only 语义。显式接管后（包括撤回后）返回 409 decision_lifecycle_required、replacement 和 preview，文件字节及正式决定均不变。精确 name_norm 有多个企业时返回 409 ambiguous_enterprise，不猜选、不接管。原比较 GET/导出继续展示旧标注。
- 预览按 JSON 元组中的精确统代或 `name:` 后的 name_norm 查索引，最多两个候选；同名歧义不选企业。始终返回 equivalentToConfirmedNoDiff=false、migrationApplied=false 和 legacy_not_equivalent；标明未匹配、歧义、坏键、坏标注、已有正式决定/撤回。没有映射自动应用操作。
- 旧文件实际读取上限 2 MiB/10000 键；摘要说明每字段最多 4000 字符，发生截取会显式标 legacy_summary_truncated。预览响应超过 256 KiB 返回 413，要求更小页或精确键；不以截断整个清单假装完整。坏 JSON 返回 422。生产旧资料迁移必须另行授权。

## 验收证据

`tests/decision-lifecycle-102-http.test.ts` 使用真实 Nuxt HTTP 与 MCP tools/call、隔离 SQLite、独立构建目录和动态保留端口；没有 mock 自有应用服务。测试最大 worker 数为 1，故障 trigger 仅在临时库作为输入注入。

1. 明确依据/操作者/规则/业务时点与稳定 ID：`appends a version with explicit actor basis rule and business time and reads it by stable ID`。
2. 替代、撤回、保留旧原因、分页、跨传输幂等及旧回执不会复活结论：`replaces then withdraws without resurfacing old reasons and pages immutable history across transports`。
3. 缺鉴权、独立凭据、非法字段/状态、精确不存在/非法分页：`rejects absent or wrong transport auth and malformed decisions without changing current state`。
4. 并发预期版本、同键异请求、插入后故障回滚/恢复、热读后的当前/列表/详情更新及原始平台响应不变：`serializes competing expected versions, rejects key reuse, and rolls back an injected post-insert failure`。
5. 可核对旧映射、歧义和冲突，不自动升级/迁移，已接管坐标的旧 PATCH 返回 409 且旧文件字节不变：`previews exact legacy mappings and conflicts without promoting reviewed annotations or modifying either store`。
6. 旧正式决定可查、无毫秒未来时点可接管、接管后旧导入不能覆盖：`keeps legacy imports readable but requires lifecycle commands after explicit adoption`。
7. 证据企业/称号错误拒绝、严格 RPC 参数、MCP stale/rollback 错误不泄漏 SQL：`rejects mismatched evidence and gives typed MCP failures without leaking internal SQL`。
8. OpenAPI 必填/动作、MCP 只读发现、单独无 token 进程关闭两种写入口：`discovers full HTTP and MCP contracts and disables writes when tokens are unconfigured`。
9. 计划后接管的执行期检查与整批回滚：`rechecks lifecycle ownership inside legacy import execution and rolls back the whole batch`。
10. 有界历史、精确长说明、不加载无关原文、索引计划、旧文件/响应上限和坏 JSON：`bounds scoped history and legacy preview while unrelated large raw evidence is never materialized`。

红绿日志在 `/tmp/ningbo-spec98/ticket-102/`：red-1..8 对应首次能力缺失、撤回、状态组合、旧预览/旧导入、历史大说明、证据/MCP 错误、契约发现和执行期竞态；green-1..8 保存修复后的干净结果。red-8 先修正了故障 trigger 不支持绑定变量的夹具错误，再重新得到 committed≠failed 的业务红灯。`final-candidate-tests.log` 为 7 文件 **212/212 通过**；包含 curation、MCP auth、统一导入、平台比较、企业读模型和差异筛选回归。最终提交绑定结果见下方。

## 性能范围与集成提示

有界性样本为确定性合成数据：200 条同坐标历史，每条原因说明 42000 UTF-8 字节；一条无关 7600000 字节平台原文和无效 collection_evidence JSON 哨兵。第二页 50 条历史摘要低于 256 KiB；详情完整取回长说明；MCP 旧差异列表不解析无关 JSON；EXPLAIN 使用既有 difference_reason_version_uq 的范围索引，无临时排序。该测试验证投影/范围/返回体与不解析无关大字段，**不是延迟或容量基准**，没有 p95/p99、2x/5x、受控容器或长期负载验收声明。未运行重型 benchmark，不与父代理的基线/候选测量争用。

新当前/精确读取按键；历史在 SQL 中 count/limit/offset；命令幂等按唯一索引；已接管判断使用部分索引；预览只在文件上限内解析键，对页内候选逐个精确查找。旧 MCP list_differences 改为 SQL 最新版本/分页和查询元数据投影，保留原 rows/counts 形状，消除其先前全量读取平台原档的路径。深页 OFFSET 仍随范围页深增加 SQL 扫描，未宣称常数耗时。

共享改动仅为 db/schema.ts、迁移 journal、server/utils/roster-import.ts 的接管守卫、mcp-auth 写名单、mcp-roster 差异摘要读取、MCP 中间件/说明，以及旧 PATCH 接管守卫；对应回归测试同步调整。迁移按预留 0018，未生成无关 snapshot；父集成合并其他预留迁移时需整理 journal 顺序。没有修改共享 GLOSSARY 或其他票据文档。

## 最终交接记录（2026-10-19）

工作树 `/Users/mang/.t3/worktrees/app/t3-b4b2e1a9`；分支 `t3/ticket-102-decision-lifecycle`。实现提交 `1e591d9`；已依次合入集成 tip `92f694e`（#100）、`f31f57b5a097223f15e7d596961af9d4ea8c6693`（#96/#99），合并提交 `755c345b05b3711a182abf45b2d5d23fa7403b13`。

最终合并候选执行：

```sh
pnpm exec vitest run tests/decision-lifecycle-102-http.test.ts tests/curation.test.ts tests/mcp-surface.test.ts tests/roster-import-api.test.ts tests/comparison-platform.test.ts tests/roster-enterprises.test.ts tests/roster-difference-filter.test.ts tests/roster-event-correction.test.ts tests/enterprise-profile-96.test.ts tests/alias-maintenance-http.test.ts --maxWorkers=1
pnpm typecheck
git diff --cached --check
```

结果：10 文件 **270/270 通过**、typecheck 退出 0、diff check 退出 0。日志为 `/tmp/ningbo-spec98/ticket-102/merged-latest-tests.log` 和 `merged-latest-typecheck.log`。测试时为待提交的合并结果，其 staged tree `5a89ed2556f77e8aa49f18c7301d99f3a872ea4d` 与上述 `755c345` 提交 tree 完全相同；没有把先前 212/223 项旧候选结果冒充本次合并验证。紧随本段记录的 `1a77026` 只更新本票文档；后续旧客户端兼容修复见下方。

共享冲突处理保留了 #96/#99/#100 的所有工具鉴权项、MCP 说明/校验器，以及迁移 0014/0015/0016；#102 的 0018 在 journal 中按顺序跟随。未创建 PR（由父集成负责），没有生产写入、生产资料迁移、部署、main 合并、CI、浏览器 UI 或完整规格最终验收声明。实时读取 #102 确认仍 OPEN、无新增评论；票据状态由父代理统一处理。


## 原实现兼容性修复

首次交付将旧 PATCH 无条件返回 410，实际仍在调用它的 `ComparisonCuration.vue` 因而失效；将原路由测试改成 helper 调用未覆盖这个回归。已恢复 `tests/curation.test.ts` 的原公开路由调用及原断言，不能把前述旧候选的测试通过当成旧客户端兼容验收。

当前过渡契约：保留 baseline 旧载荷校验、成功返回体及未接管坐标的全部标注语义，也保持旧入口原有鉴权行为供现有 UI 调用；新正式命令的 token、操作者、依据、规则、业务时点和 expectedCurrentId 要求不变。旧标注始终是独立 annotation，不自动迁移/升级成 confirmed_no_diff，不新增 UI 或设计工作。

旧 PATCH 在同步 JSON 写入前只查最多两个企业 ID：有 uscc 时按既有规范化统代精确查唯一索引（保留原 JSON key 写法），不按名称兜底；否则按调用方 nameNorm 精确查名称索引，不搜别名、不模糊匹配。多个候选返回 409 ambiguous_enterprise；零匹配保留原 JSON-only 写法。唯一匹配后，按企业×称号×方向及 lifecycle_action 非空的现有部分索引检查是否已显式接管；已接管无论当前解释有效或撤回，任何旧标注操作均返回 409 decision_lifecycle_required，含 replacement/preview，且先拒绝再读改写 JSON。其他称号或方向仍兼容。检查与同步原文件写入共用 SQLite immediate 事务锁，与新命令串行，避免检查后被另一连接接管再继续写。没有新增迁移或全库/原始平台字段读取，旧 JSON 自身的原有读改写方式保留。

真实 Nuxt HTTP + 隔离 SQLite 验收名称：

- `preserves the public legacy PATCH payload output and note omission semantics without creating a decision`：无新增 token/元数据要求、原返回体、比较 GET 读回、重复/省略 note 保持原文件字节、空串清空、取消、非法载荷 400、精确未匹配键兼容；current/history 证明没有自动创建正式决定。
- `rejects ambiguous legacy identities without selecting or adopting an enterprise`：同 name_norm 两企业返回 409，文件原字节不变、两企业 versionId 仍 null；显式 uscc 可精确区分。
- `blocks only the explicitly adopted legacy coordinate even after withdrawal and preserves both stores on conflict`：接管后 true/false/备注修改、规范化统代与精确 name_norm 均 409；文件字节和正式决定不变；撤回后仍保护；同企业其他称号/方向仍按原返回体成功。
- 既有 `previews exact legacy mappings and conflicts without promoting reviewed annotations or modifying either store` 已将被测公开冲突更新为指定的 409 decision_lifecycle_required；预览无自动迁移的不变量保留。
- 大字段哨兵用例增加了无关平台原文/无效原文 JSON 存在时旧 PATCH 仍能按精确键完成的断言。该验证仅证明读取路径与边界，仍不声明容量或尾延迟验收。

红绿日志：`/tmp/ningbo-spec98/ticket-102/compat-red-1.log` 记录无条件 410 下 **16 失败 / 10 通过**；`compat-green-1.log` 为修复后 **26/26 通过**。`compat-red-adoption-mutant.log` 临时移除接管守卫，仅跑上述接管范围用例，明确以 **200 应为 409** 失败；正确守卫已恢复，最终干净结果见本次交接记录。没有以 helper 替代公开入口验收。

### 兼容修复最终交接（2026-10-19）

修复提交 `cccbed1`；已合入当前集成 tip `4586bf09db80320855bf5f2c4fb8597b8b55364a`，合并提交 `b3a45a9e715d81defdaef89ff85971c3666c6a4b`。合并候选 staged tree `dd341975f9681d8fc2075e80551a9dbb06d6e422` 与该提交 tree 一致。

```sh
pnpm exec vitest run tests/curation.test.ts tests/decision-lifecycle-102-http.test.ts tests/mcp-surface.test.ts tests/comparison-export.test.ts tests/comparison-platform.test.ts tests/parse-maintenance-105-http.test.ts tests/ocr-page-lifecycle-106.test.ts --maxWorkers=1
pnpm typecheck
git diff --cached --check
```

结果为 **7 文件 101/101 通过**，typecheck 退出 0，diff check 退出 0；最终干净日志为 `/tmp/ningbo-spec98/ticket-102/compat-merged-tests.log` 和 `compat-merged-typecheck.log`。`compat-green-2.log` 单独记录本票两个文件 **27/27 通过**；合并候选保留相同用例并增加未接管正式旧解释可继续标注、且其旧原因不被修改的断言。没有以旧候选或变异实现的结果冒充最终通过。

共享冲突处理同时保留 decisionRpcError102 与 parseRpcError105、全部工具鉴权名单及测试。journal 保留集成 tip 已有条目的 idx/when，将本票原有 0018 条目追加为 idx=19，when=1792390000018 保持时间单调，避免漏掉已合入的 0021/0022；未改迁移 SQL 或生成无关 snapshot，后续各票 journal 仍由父集成统一整理。本次新增服务只负责旧 PATCH 的索引身份解析与接管检查；lib/curation.ts 原解析和写入语义未修改，UI 未修改，新决定服务的严格要求未修改。最终文档后继提交只更新本票说明；未创建 PR、部署、写生产资料或合并 main。

最终集成追加顺序修正：本票0018在4586bf0原有全部条目、0017（idx19/when1792380000023）与0020（idx20/when1792400021001）后追加，最终idx21/when1792400021002；既有条目idx/when/顺序不变。上文idx19/when1792390000018仅为历史候选记录，不是最终执行编排。SQL编号不是执行顺序。
