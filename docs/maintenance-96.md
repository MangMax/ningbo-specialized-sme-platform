# #96 企业普通资料维护

本切片只更正同一企业的普通资料，不执行身份补全、归并、别名生命周期决定或生产资料迁移。稳定企业 ID、正式记录/事件/出处、平台查询/关联原行不被 PATCH 改写。

## 公开入口

| REST | MCP | 用途 |
| --- | --- | --- |
| `GET /api/roster/enterprises/:id/profile` | `get_enterprise_profile({enterpriseId})` | 轻量 `{profile,version}`；profile 为 enterpriseId/name/city/district |
| `PATCH /api/roster/enterprises/:id` | `patch_enterprise_profile({enterpriseId,request})` | 同一事务更正、保留旧名、追加审计及幂等回执 |
| `GET /api/roster/enterprises/:id/profile-history?page=1&pageSize=25` | `get_enterprise_profile_history({enterpriseId,page,pageSize})` | 新到旧分页 `{rows,total,page,pageSize}` |

读取与现有企业详情同为公开只读；审计包含调用方声明的 actor 和依据，勿放入凭证或私密内容。REST 写入需 `NUXT_API_TOKEN`（Bearer 或 X-API-Token）；MCP 写入需 `NUXT_MCP_TOKEN`，无合法 token 不出现在 tools/list，强行 tools/call 返回 HTTP 401。未配置 token 时关闭写入。响应均 no-store；OpenAPI 开发环境可发现，生产默认文档隐藏策略不变。

## 白名单和前置条件

```json
{
  "idempotencyKey": "enterprise-96-verified-rename-v1",
  "expectedVersion": "<GET profile 返回的 64 位十六进制 version>",
  "expectedValues": { "name": "已核对的旧名称", "city": "宁波市" },
  "changes": { "name": "已核对的现名称", "city": null, "district": "鄞州区" },
  "previousName": { "name": "已核对的旧名称", "sameSubject": true },
  "actor": { "type": "agent", "id": "明确的调用方标识" },
  "basis": "同一企业名称及当前属地的核对依据"
}
```

- `changes` 至少一个字段，且只认 `name`、`city`、`district`。省略不改，city/district:null 显式清空；name:null 拒绝。新值 trim 后不可为空；名称最多300、城市/区县最多100个 UTF-16 码元，拒绝控制字符与孤立代理项。属地是企业当前资料，不覆盖正式名单历史属地；调用方应提供已核对、归一化后的名称和属地，系统不推断迁移。
- `regStatus` 表示登记状态；平台流程状态表示原始申报/业务过程；差异状态表示当前解释；rosterState、质量标记等为派生或未冻结语义。以上均不在白名单。统代、ID、nameNorm、称号/事件/出处字段也拒绝；信用代码补全、身份冲突、跨企业归并继续走专用操作。
- `expectedVersion` 必填，是资料、nameNorm、统代及最近一次资料审计键的摘要，不是业务时点。每次新请求（即使值未变化）追加审计并更新版本，避免本入口的 A→B→A 恢复旧版本。其它既有写入口改变当前资料/身份也会使旧摘要失效；不会宣称摘要能捕获其它入口未留审计的完整 ABA 历史。
- `expectedValues` 可选，逐个精确核对旧 name/city/district；省略某项不核对该项，null 与省略不同。旧值和 `previousName.name` 不 trim，保留历史原值的首尾空格，最长1000码元。
- actor.type 为 user/agent，id 最长200；依据必填且最长2000，幂等键最长200。actor 是调用方声明，不冒充 token 所属人员认证。新请求不能省略 actor、依据、版本或幂等键；未知顶层或嵌套字段整次拒绝。

## 更名、别名及事务

仅 name 实际变化时必须携带精确旧名和 sameSubject:true；没有名称变化却带旧名确认也拒绝。新名或旧名若与其它企业现名/确认别名冲突，409 identity_conflict，交给身份操作解决，不自动合并。

旧名按共享 normalizeName 归一化查找本企业确认别名；已有确认记录直接复用 ID，不修改其原名、来源、有效时间、核验状态、version 或历史。否则新增 manual/sourceRefId=0 的 confirmed 别名，时间未知保持 null。同键已存在 pending 或 withdrawn 时返回409 alias_lifecycle_required，须先经 #99 确认/恢复；#96 不静默提升状态。若已有确认记录的原写法不同，精确旧主名称仍保存在本次 profile 审计 before 与回执 retainedAlias.name 中。

资料、旧名保留及 profile 审计在同一个 SQLite IMMEDIATE 事务内提交。存储异常全部回滚；冲突/拒绝不占用新幂等键。全局 profile 幂等键绑定企业 ID 和规范化请求：同键同请求直接返回原 `{auditId,profile,version,retainedAlias,committedAt}`，不追加审计；后续资料已改变时重放也返回当初回执，当前状态另 GET profile。同键异请求或不同企业返回409。此键空间独立于导入/别名等其它领域命令。

## 历史、读回及性能边界

迁移 `0014_enterprise_profile.sql` 仅增加 enterprise_profile_audit 与幂等/企业历史索引，不改 enterprise_alias 表、既有行或其它迁移快照。审计保存前后值/版本、actor、依据、保留旧名ID、是否新建及时间；查询不默认返回请求原文、请求hash或幂等键。

enterpriseId 和 retainedAliasId 是不可变历史目标值，不加阻止专用归并的外键。归并移除源企业后，GET profile 返回404，profile-history 仍可按原ID读历史；已提交请求可按原请求重放。#96 不修改 executeMerge 或重新指派旧审计。

资料读取按主键和最近一条审计索引点读，不加载质量标记、正式历史或平台原文。历史按企业ID在 SQLite 计数/排序/分页，page=1..10000、pageSize=1..100（默认25）。编码页面上限256KiB，超限413 response_too_large，调用方缩小页长重取，绝不截断行。404 区分企业/历史不存在，400 为输入非法，409 为版本/旧值/幂等/身份/别名生命周期冲突，422 为缺少旧名确认或名称归一化为空。

既有企业列表/详情执行器无结果缓存，每次在提交后的只读快照读取。现名和确认旧名均能查到同一企业，正式记录及原始证据保持不变；对应来源指纹包含企业资料，既有读模型会将相关确认决定标为 requiresRevalidation，而不会悄悄继续视为有效。

## 验收和复现

```sh
pnpm test tests/enterprise-profile-96.test.ts tests/mcp-surface.test.ts tests/roster-duplicate-merge.test.ts tests/roster-import-api.test.ts tests/roster-enterprises.test.ts tests/enterprise-read-http.test.ts tests/record-correspondence-api.test.ts --maxWorkers=1
node scripts/verify-enterprise-profile-96.mjs
pnpm typecheck
pnpm build
```

| 要求 | 测试/证据 |
| --- | --- |
| 白名单、null/省略、actor/依据、身份保护 | `PATCH updates whitelisted profile fields and retains explicitly confirmed old name atomically`；`PATCH requires authentication, explicit actor and basis, and a real stable enterprise ID`；`PATCH rejects $label fields without partial changes` |
| 并发/旧值/版本 | `PATCH has one concurrent winner and rejects stale versions and mismatched old values without consuming a key`；`PATCH detects identity-key changes and returning to an earlier profile does not revive an old version` |
| 幂等恢复 | `PATCH replay returns the original receipt after later edits and rejects same-key different requests` |
| 旧名去重和 #99 边界 | `PATCH deduplicates confirmed old names without modifying original alias evidence or dates`；`PATCH leaves a $label old-name natural key to alias lifecycle`；`PATCH refuses ambiguous old-name retention across enterprises without partial changes` |
| 回滚和精确保留 | `PATCH rolls back name, retained alias and audit when the audit store rejects the transaction`；`PATCH accepts exact legacy old-name whitespace and preserves the original value in retained evidence` |
| 列表/详情/现名旧名/来源一致 | `PATCH preserves formal rows, source evidence, platform originals and readback by both names`；真实 verifier 的 `profile corrections retain correspondence history and trigger existing source-fingerprint revalidation` |
| 有界历史、归并保史 | `profile history is scoped, bounded, ordered and omits stored request hashes and idempotency keys`；`profile history rejects an oversized encoded page and lets callers request a smaller complete page`；`profile audit preserves its historical enterprise ID after dedicated identity removal` |
| 查询范围/索引及性能边界 | `profile and history reads stay scoped as unrelated malformed archives and audit rows grow`：1000无关企业、1000无关审计、50条各64KiB无关原文；前后各5组HTTP资料+历史读取；附精确索引计划。小合成分布，不作2x/5x或尾延迟/生产容量结论 |
| 真实公开接缝 | verifier 自行启动独占端口 Nuxt、隔离 SQLite/文件，全部业务种子经公开注册/导入；实测 OpenAPI、tools/list、鉴权401、tools/call 与 REST双向维护、重放/拒绝、列表/详情/历史及对应待重核 |

原始日志和测量保留在 Git 外 `/tmp/ningbo-spec98/ticket-96/`。PROFILE96_REPORT 可记录真实服务验证报告；PROFILE96_MEASUREMENTS 与 PROFILE96_SOURCE_SHA 可记录精确提交下的有界性样本。没有 UI 变更，不宣称桌面/390px、生产或受控完整分布性能验收；未部署、写生产或合并 main。集成父线程负责最终规格及跨票验收。
