# #103 导入批次回执与逐项结果读取

本票为既有统一导入增加只读 REST/MCP 回执查询。企业、正式事件、出处、对应决定与范围证明仍沿用各自的写服务。本票不新增通用 CRUD，不部署、不操作生产数据、不创建 PR、不合并 main。

## 代理使用契约

以下 REST 路径都在 `/api/roster/import/receipts` 下，仅 GET，且始终 `Cache-Control: no-store`。

| REST | MCP | 结果 |
| --- | --- | --- |
| 根路径 | `get_roster_import_receipt` | 批次最新回执或指定历史回执的状态、时间、摘要与项数，不附全量 items/预检冲突/请求 |
| `/items` | `list_roster_import_items` | 稳定原项序号分页：index、ok、kind、ref、errorCode、errorField；不返回大 detail、错误消息原文和内部出处收敛计划 |
| `/history` | `list_roster_import_receipts` | 同批次追加的预检、提交、显式收敛重放回执；按 receiptId 升序分页 |
| `/request` | `get_roster_import_request` | 显式读取留存请求的脱敏 JSON 字节块 |

根路径、items、request 的选择器为 **batchId、idempotencyKey、receiptId 三选一**；history 为 batchId、idempotencyKey 二选一，不开放全库回执扫描。幂等键按原值精确匹配；REST 使用 URL query 编码，含 `/`、`?`、中文的键无需转成路径参数。batchId/receiptId 是正安全整数；key 非空且最多 4096 字符。history 的批次范围即查询范围。

分页 page 默认 1、最大 1,000,000；pageSize 默认 20、最大 50。未知 REST query 字段、重复参数、混用选择器、非整数字段与超限参数返回 400 invalid_query；MCP schema 非法参数由 MCP 返回 tool error，选择器组合等领域错误保留同名 error.code。页尾返回空 rows 和原 total，不伪造不存在批次。只有导入的 announcement/platform_export/alias_evidence 批次可用此入口；共享批次表中的对应决定/范围证明使用自己的查询。

状态：

- preflight：只完成预检，尚无已提交结果；其 items 为预检冲突项。
- processing：已持久化本次提交尝试，但尚无终态回执；可能正在执行或进程中断，不能推断成功/失败。只读查询不会替它重试。
- failed：本次尝试失败；逐项错误可分页定位。业务事务仍整体回滚。
- committed：已有提交终态；历史重放操作在 operation=replay 中区分。
- 不存在目标：REST 404 not_found；MCP `isError=true`，JSON 内容含同名 error.code。不存在不是 failed 或空批次。

恢复流程：先保留原 idempotencyKey，再 POST 原请求体；若断线，按 key GET 根路径/MCP 点读，再分页核对 items。查询不会重新规划、执行导入、插入批次、消费新 key 或改变原回执。只有调用方显式重试原提交或显式 replay 才会执行命令。

## 原文、权限与兼容

所有四个读取均要求各自的凭据：REST 使用 NUXT_API_TOKEN（Bearer 或 X-API-Token），MCP 使用 NUXT_MCP_TOKEN（Bearer 或既有 X-MCP-Token 解析）。缺失、不匹配、交叉使用或服务端未配置均拒绝。MCP 未鉴权时不展示这些工具；鉴权工具注册常量沿用历史名称 MCP_WRITE_TOOLS，其中本票四个工具仍声明 readOnlyHint=true。

request 只返回校验后原请求体的 JSON 语义，不保证原始字节、空白、键顺序或被校验器忽略的顶层字段。它仍是 `{idempotencyKey, sourceKind, sourceIdentity, sourceSha256, payload}`，**不改成 `{request, planHash}`**。身份、来源 SHA 与现有业务服务照常使用原值；脱敏只影响新增留存副本/读取投影。请求指纹为校验后请求的确定性 SHA-256，按对象键排序，数组保持顺序；不对外返回指纹或凭据。

留存前递归遮盖凭据字段；字符串复用现有来源证据的 JSON/转义/URI 编码脱敏，并遮盖已配置 API/MCP、平台会话、OCR 凭据及 Bearer 值。新增逐项历史副本也脱敏。默认逐项读取仅投影有限字段，不暴露任意 detail/error.message。默认元数据还使用相同已知凭据脱敏。幂等键/来源身份显示上限各 4096 字符，分别以 idempotencyKeyTruncated/sourceIdentityTruncated 明示超长；此时固定 batchId 读取，未留存旧原文不补造。逐项 kind/errorCode/errorField 上限 128、ref 上限 256；完整请求仅从显式 request 读取。

request 的 offset 是 **UTF-8 字节偏移**，默认 0；maxBytes 默认 16384、最大 65536。data 是 base64；调用方先解码成字节，按 nextOffset 拼接，再统一 UTF-8/JSON 解码。nextOffset=null 表示结束；offset 等于总字节数返回空块，大于总字节数返回 400。块上限包含被请求的实际字节数，base64 编码有额外开销。不同次尝试请固定 receiptId，避免最新回执改变后混拼原文。

迁移前的旧批次不补造历史、不推断请求：receiptId=null、originalRequest=not_retained；history 为空，items 可分页读取现存结果；request 返回 404 not_retained。旧摘要缺 evidenceRepointed 时仍补 0。

新留存的已提交普通导入，同键同请求返回既有业务摘要且不追加新回执；同键异来源或异请求为 409 idempotency_conflict，MCP 保留该领域错误码。仅预检/失败批次仍可修正载荷并用同键提交，旧尝试保留。无请求指纹的历史已提交批次保留既有同来源重发语义，不猜测其原请求是否相同。显式 `/replay` 保留原来的重新收敛语义（包括来源集合换序），按既有 `<key>#repoint` 批次记账；新增回执只记录它，不将其误改成普通提交的一次性命令。所有旧请求/响应封套保持兼容。

## 存储与并发

仅新增迁移 `0019_import_receipts.sql`、schema.importReceipt 与按 (batch_id,id) 的索引；不搬迁、删除或覆写旧批次历史。迁移序号 #103=0019，集成时由父线程统一整理 journal 顺序，不重生成其他 snapshot 元数据。

新尝试先持久化 processing；既有业务事务、批次终态和新回执终态再在同连接的外层事务中一起提交。进程中断在终态提交前只留下 processing，不会把已提交业务误报成未写入；它也不自动判失败。终态回执不因读取、同键重发或后续修正而改写。未完成历史尝试保留，不借重试改写它的状态。原数据库写锁、唯一键和子事务回滚规则保留；来源冲突在记新尝试前拒绝。

读取使用只读事务保证多条 SELECT 处于同一 SQLite 快照；主键/唯一幂等键定位批次，索引限定本批次历史，SQL 投影避免把完整请求/预检/detail 装入 V8。items 使用选定回执/旧批次的 JSON 数组在 SQLite 内分页；这仍会解析**目标数组**，不声称任意大单批的 CPU/SQLite 内存为常数。原文用 SQL BLOB substr 取有界字节，不先把完整原文加载到 JavaScript。保留既有优化与读缓存边界；新增读取不接入共享摘要缓存。

## 验收与证据

测试文件 `tests/import-receipts-http.test.ts` 运行真实 Nuxt HTTP 和 MCP tools/call，使用隔离 SQLite、随机独占端口、独立 Nuxt buildDir；夹具之外的被测提交都从公共接口进入。只读进程中断态用显式 processing 夹具表示；真实断线用 POST 收到响应头后销毁响应流、放弃读取回执，再通过原 key 查询，验证的是“客户端丢失回执”而非任意 SIGKILL 时刻。

| Requirement | Evidence |
| --- | --- |
| 旧批次 ID/key 精确读及无伪造历史 | `reads an exact legacy batch by ID or key without creating a receipt` |
| 旧长元数据有界/明确截断标记、旧结果无 detail | `bounds legacy metadata and item projections without loading raw result details` |
| 原请求体、真实断线恢复、同键恢复与不重复追加 | `recovers a committed original-body submission after losing its response without replaying it` |
| 失败修正、异请求/异来源冲突、历史不变、MCP 错误码 | `preserves immutable failed history while correcting the same key and rejects a different committed request` |
| 稳定逐项分页、空页、REST/MCP 对等 | `pages exact item outcomes in stable input order without raw or private details on either transport` |
| 按需大原文、脱敏、UTF-8 跨块、EOF/越界 | `reads only explicitly requested redacted UTF8 byte chunks and never defaults to the full request` |
| processing/preflight/not_found、外域隔离与不消费 key | `distinguishes processing, preflight, failure and not found without consuming missing keys` |
| 真实事务失败、整批回滚、同键修正并跨传输提交 | `retains failed transaction outcomes and rolls back business writes before same-key correction` |
| 凭据独立、隐藏工具、受保护只读属性 | `enforces independent credentials and advertises read-only receipt tools only to authorized callers` |
| 参数上限与错误分区 | `rejects invalid selectors and unbounded pagination on both public transports` |
| OpenAPI 新能力/状态 schema 和原提交体兼容 | `exposes all receipt reads in OpenAPI without replacing the original-body commit schema` |
| 有界响应与无关原文增长 | `keeps fixed-page responses bounded when unrelated retained request bytes grow` |
| 未配置凭据关闭 | `disables protected reads when credentials are unconfigured` |

红绿日志留在 Git 外 `/tmp/ningbo-spec98/ticket-103/`：red/green-1（旧批次路由）、2（真实提交留存）、3（历史 MCP）、4（逐项路由）、5（显式原文）、6-redaction（编码会话/已知凭据）、7-openapi（状态 schema）、8-mcp-errors（领域错误码）。另以移除 REST 权限拒绝的错误实现运行鉴权用例，要求 red-9-auth-mutation 失败，再恢复正确代码跑绿色验收。red/green-10-metadata 检查超长旧幂等键的投影上限。最初新增用例的写入计数按既有 sourceDocument 复用规则校正；不把该测试预期修正当成功能修复。

复现：

```sh
pnpm test tests/import-receipts-http.test.ts tests/roster-import-api.test.ts tests/roster-import-scale.test.ts tests/roster-import-semantics.test.ts tests/mcp-surface.test.ts --maxWorkers=1
pnpm typecheck
pnpm build
```

boundedness.json 记录实际测量 sourceSha、样本分布、响应字节数与前后单次热请求耗时；使用 120 个真实提交项，新增 30 个无关合成回执及约 5 MiB 请求/约 10 MiB 结果填充，核对同一摘要/末页响应逐字一致，摘要 <2 KiB、逐项页 <16 KiB、显式原文块 4096 字节。这里只证明目标查询范围与输出上限，样本不支持 p95/p99、2x/5x 容量、部署 SLO 或长期混合负载结论。原有性能票的未验收边界保持；父线程负责串行全分布测量。未做生产、真实用户凭据、浏览器 UI 或部署验收（本票无 UI 修改）。最终 SHA、通过数量与集成 tip 合并记录见父线程交付。

合并集成 tip f31f57b 后，旧 RL-18 黄金快照因 #99/#100 新 schema 默认列失败。已在不含 #103 的 f31f57b 隔离 checkout 复现同一失败（parent-f31f57b-golden-red.log），并验证新黄金**只有 7 个新增默认值**：三条事件 revision=1、一条别名 version=1 与三个 original* 为 null。所有既有值、outcome、行数及摘要保持不变；字段级差异证明为 golden-delta-proof.json。只更新合成黄金及归因注释，不调整 #103 的业务行为，也不以删除原断言消除失败。

最终集成追加顺序：保留4586bf0全部journal条目，依次追加0017、0020、0018、本票0019；本票idx22/when1792400021003，严格大于前一0018的when1792400021002。SQL编号不是执行顺序，不重写已应用ledger。集成保留#102规划/执行接管守卫、#99别名审计安全归并以及本票processing/终态原子事务包装。
