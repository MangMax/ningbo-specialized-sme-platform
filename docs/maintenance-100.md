# #100 正式事件精确更正

本票只维护经信局正式事件字段。#34 母票保持不变；出处坐标更正及旧页码入口由 #101 负责。没有生产数据写入、部署、main 合并或 PR 创建。

## 公开契约

| REST | MCP | 行为 |
| --- | --- | --- |
| `GET /api/roster/events/:id` | `get_official_event({eventId})` | 精确读取 event/revision、所属 record、全部原 evidence、文件哈希元数据及现有生命周期；不加载平台原文 |
| `POST /api/roster/events/corrections/preflight` | `preflight_event_corrections` | 绑定有界请求和来源快照；返回批次、planHash、逐项 before/after、生命周期 before/after、对应影响 |
| `POST /api/roster/events/corrections/commit` | `commit_event_corrections` | 原 request + planHash；单个 SQLite immediate 事务更正、追加审计、保存回执 |
| `GET /api/roster/events/:id/audit?page=1&pageSize=50` | `get_event_correction_audit` | 按事件 ID 升序分页；pageSize 1–100，返回 before/after、actor、basis、sourceIdentity、原出处和时间；不存在事件 404 |

REST 写入使用 `NUXT_API_TOKEN`，MCP 使用独立的 `NUXT_MCP_TOKEN`。未配置即关闭写入；未鉴权的 MCP 不列出写工具且强行调用返回 401。读取沿用公开、脱敏、no-store 策略。开发态 OpenAPI 可发现新路由；生产态文档仍明确 404。

预检请求示例（ID 均为示意）：

```json
{
  "idempotencyKey": "event-review:42:correction-1",
  "sourceIdentity": "verified-announcement:42",
  "actor": { "type": "agent", "id": "roster-cleanup" },
  "basis": "已核对原公布文件的对应附件与名单行",
  "operations": [{
    "eventId": 42,
    "recordId": 15,
    "enterpriseId": 8,
    "expectedRevision": 1,
    "patch": { "eventType": "review", "year": 2021, "decidedYear": 2024, "batchSeq": 1, "reviewOutcome": "failed" }
  }]
}
```

提交封套为 `{ "request": <原预检请求>, "planHash": <预检返回值> }`。这不改变现有导入的原请求体协议或对应服务的既有协议。同键同请求重放原回执，包括原 committedAt；同键异请求拒绝。预检重试返回原绑定计划，来源漂移须新 key 重新预检；不能重新绑定旧 key 绕过冲突。事务故障保留 preflight 状态，无部分事件/版本/审计/回执；修复故障后同键原计划可重试。

## 字段与业务约束

- 严格白名单：eventType=`award|review|nurture`、year、decidedYear、batchSeq、reviewOutcome=`passed|failed|null`、formalValidity。formalValidity 可省略（保留）、为 null（明确撤回该事实），或为严格对象；见[正式事件有效期事实](roster-lifecycle-contract.md#正式事件有效期事实纠偏增量尚不改变资格裁定)及紧随其后的[正式有效期消费（历史 v2，非当前默认版本）说明](roster-lifecycle-contract.md#正式有效期消费current-roster-116-v9--enterprise-qualification-407-v2)。显式 407-v1 兼容调用仍不消费该字段；事实写入成功不等于资格已判为 eligible。未知字段（包括 event/record/enterprise ID、sortKey、出处坐标、平台状态等进入 patch）拒绝；MCP 原 RPC 参数另校验，避免 SDK 静默剥离顶层未知字段。
- 省略字段保留；显式 null 表示未知。年份为 1900–9999 整数或 null；批次为正安全整数或 null。结论年不早于已知所涉年；非 review 的复核结果必须为空。复核结果未知保留未知，不推定通过；不强制推算三年结论或批次。
- 只接受既有 jxj 事件，不改平台 maintain 事实；nurture 仍不构成称号。变更 year 同步原派生 sortKey。空 patch、无变化、空依据、无正式出处、重复目标拒绝。
- 所属企业、记录、预期 revision 必须匹配。自然键按同记录的 `(eventType, year, batchSeq)`（含 null）检查，结论不同也不能借更正叠加同坐标事件；同批目标汇聚冲突一并检查。整批失败，不合并或新增替代事件。
- 稳定事件/记录/企业 ID 与所有 evidence ID/坐标保留。审计追加 before/after、来源依据及操作者；不覆盖审计与原出处。预检绑定事件、record、全部 evidence、库内文件哈希/状态、相关对应版本/状态和生命周期；提交时重算并验证。
- 生命周期复用现有公式，无新的业务结论写表。首次认定、复核终止/恢复及到期读回使用提交后事实；读取没有跨提交保留的更正结果缓存。

## #101 共享接口及指纹兼容

`server/utils/roster-event-version.ts` 导出：

```ts
advanceOfficialEventRevision(tx, eventId, expectedRevision): number
```

调用方在自己的原子事务内，每个实际改变的正式事件调用一次（同事件更正多个出处时先去重），返回递增版本。预期版本不符抛出 `{code:'stale_revision',statusCode:409}`。helper 不独立提交、不写 event correction 审计、不修改出处或对应边；#101 在自己的事务中写自己的审计即可。迁移 0016 添加 `record_event.revision DEFAULT 1 NOT NULL`，所以 #101 须建立在该迁移/共享 helper 之上。

对应现有动态来源指纹继续覆盖具体事件、直接边及 later_process 的 predecessor、出处和文件元数据。版本 1 的事件投影移除新 revision 字段，保持旧确认与 official coverage proof 的原哈希兼容；版本 >1 纳入递增值。A→B→A 不会复活旧确认：原边/审计保留，公开 `requiresRevalidation=true`，比较读模型不消费它作为有效确认；必须显式重核。同边 correct 仍复用已有对应服务及追加审计。official coverage proof 同样绑定事件版本，来源更正即失效。没有自动改成其他对应结论。

共享改动限于 db/schema、迁移 journal（只加 0016，无重生成 snapshot）、MCP 写工具名单/说明/原参数守卫、correspondence 来源投影、official coverage 来源投影，以及 comparison 的有界 SQL 事件投影补 revision。0016 另加 `record_correspondence_predecessor_idx`，避免按受影响 predecessor 查找时扫全对应表；审计索引 `(event_id,id)` 支持点查分页。集成 merger 需按实际合入顺序统一迁移 journal 的 idx/when。

## 验收证据

新增 `tests/roster-event-correction.test.ts` 使用隔离 SQLite、真实 h3 路由与随机 loopback 端口，SQL 仅用于夹具和故障注入；动作及断言走公开 HTTP。`scripts/verify-event-correction-100.mjs` 使用隔离合成库启动本地编译产物，真正请求 MCP tools/list/tools/call；`--dev` 另核验开发态 OpenAPI。传输凭据独立，测试不访问平台。

| Requirement | Evidence |
| --- | --- |
| 稳定 ID、原地更正、审计、重放 | `corrects the exact official event in place and replays the receipt with preserved evidence and audit` |
| 鉴权、白名单、依据、目标身份、非法组合 | `rejects unauthorized, malformed, non-whitelist and inconsistent corrections without changing the event`；`rejects missing official evidence and platform-maintenance targets without changing unrelated rows` |
| 类型、年份、批次、结果与 null/省略 | `allows review unknown/null transitions and recomputes termination without replacing official evidence` |
| 生命周期终止/恢复及首次认定不重置 | `terminates an existing award lifecycle when a passed review is corrected to failed and recovers only after a new decision` |
| 自然键及批内冲突 | `rejects natural-key collisions including two targets converging in the same batch` |
| 旧版本、文件/出处指纹漂移、并发计划及幂等冲突 | `binds source snapshots and rejects evidence drift, stale concurrent plans and changed idempotent requests`；公开脚本双客户端竞争只允许一个提交 |
| 原子回滚、同键故障恢复 | `rolls back the first update, revisions, audit and receipt if a later update fails, then recovers the same key`；公开脚本在 MCP commit 注入审计失败、读回未变并恢复同键 |
| 旧指纹兼容、直接/前驱确认失效、ABA 和显式重核 | `marks direct and predecessor confirmations stale after correction and after restoring original values until explicit reconfirmation` |
| 300 目标边界、有界审计、无关数据增长不增响应 | `accepts the 300-target bound and rejects an extra target before any event change`；`keeps exact reads and audit pages fixed when unrelated raw evidence and event histories grow` |
| REST/MCP 发现、输入输出与鉴权对等 | `node scripts/verify-event-correction-100.mjs` 与 `--dev`：跨通路预检/提交/重放、精确读回、分页审计、错误/鉴权/未知参数、MCP 回滚、OpenAPI |

红绿原始日志保留在 Git 外 `/tmp/ningbo-spec98/ticket-100/`：`red-public.log`（基线 MCP 缺能力）、`red-mcp-unknown.log`（SDK 旧行为 200 而应 400）、`red-aba-mutant.log`（移除版本指纹导致 A→B→A 自动恢复，公开 HTTP 断言失败）。对应正确实现已恢复并验证；早期 WIP 日志绑定基线 SHA 加未提交改动，不冒充最终提交验证。最终提交后的重跑日志使用 `final-*` 前缀，脚本打印 sourceSha/sourceDirty。

最终复现命令：

```sh
pnpm test tests/roster-event-correction.test.ts tests/record-correspondence-core.test.ts tests/record-correspondence-api.test.ts tests/record-correspondence-bounded.test.ts tests/comparison-scope-proof.test.ts tests/comparison-scope-proof-http.test.ts tests/record-comparison.test.ts tests/record-comparison-http.test.ts tests/record-comparison-bounded.test.ts tests/record-comparison-snapshot.test.ts tests/roster-recognitions-api.test.ts tests/roster-lifecycle.test.ts tests/mcp-surface.test.ts --maxWorkers=1
pnpm typecheck
pnpm build
node scripts/verify-event-correction-100.mjs
node scripts/verify-event-correction-100.mjs --dev
```

## 性能范围和未验收边界

只按事件、记录/企业×称号、文件路径、对应 event/predecessor 或批次幂等键读取；不加载平台查询/关系原文。请求最多 300 目标、1 MiB；单事件最多 300 出处、300 对应影响，超限明确 413，不静默截断。审计 SQL LIMIT/OFFSET 和同范围 count，不默认取请求原文。相同记录/企业×称号的规划读取局部复用，不放共享缓存。

有界性夹具增加另一企业的 2,000 事件和 100 条各 65,000 字节查询原文（共 6.5 MB），比较固定事件及审计页逐字相同且响应 <4 KiB；记录 5 次真实 loopback 点读样本，不据此估计尾分位或容量。测量 source SHA、各耗时和响应字节打印于 `final-focused.log`，样本仅合成无关增长，不是完整业务分布 2x/5x，也不是 1vCPU/4GiB 或长期混合负载验收。未做 UI、生产或父规格最终集成验收；现有 #81–89 未完成边界不变。
