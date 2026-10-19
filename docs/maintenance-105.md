# #105 文件解析段与解析状态维护

范围：只维护文件的代理解析段、解析状态和追加式维护回执。REST/MCP 共用
`server/utils/parse-maintenance-105.ts`，段的归一、派生重建与冲突计算沿用
`parse-result.ts` / `file-parts.ts`。不产生名录企业、记录、事件、出处，不修改文件分类、
磁盘身份、OCR 内容或业务原始事实。`parsed` 只表示解析完成，不代表校验通过或称号成立。

## 公开契约及代理步骤

1. 从文件目录拿稳定 `fileId`，读取 `GET /api/files/{id}/parse-result` 或 MCP
   `get_file_parse_result({fileId})`。返回
   `{fileId,parseState,parts,version,removedAt}`；每段保留 `origin`、`hasConflict`。
   这些入口只点读，不扫描磁盘、不回填文件，也不重建派生缓存。
2. 替换全部代理声明用 `PUT /api/files/{id}/parse-result`，`parts` 必填。
   MCP `save_parse_result` 提供 `parts` 时是同一操作。未列出的旧代理段撤回，
   `[]` 清空全部代理段，但从现存出处恢复派生段；同坐标代理优先，代理行数与当前
   出处聚合行数不等时 `hasConflict=true`。旧 `legacy` 段沿用既有全量替换行为，
   修改前快照留在回执，不将其误称为来源历史删除。`parseState` 省略时置 `parsed`。
3. 只改状态用 `PATCH /api/files/{id}/parse-result`，必须提供 `parseState`，禁止
   `parts`。MCP 省略 `parts`、提供 `parseState` 对等；全部已有段逐项保留，
   包括 origin/conflict。省略不等于 null：`parts:null`、`parseState:null` 均拒绝。
4. 每次写入必须有 `expectedVersion`、`idempotencyKey`、`actor:{type,id}`、`reason`。
   REST 写入使用 `NUXT_API_TOKEN`，MCP 使用 `NUXT_MCP_TOKEN`；Bearer 或已有对应
   token header。未配置 token 时写入关闭。读入口不需要 token，所有响应 `no-store`。
5. 响应为 `{receiptId,replayed,state}`。首次写入 `replayed=false`；超时/断线后以
   同键、同规范载荷重试，返回原始回执及当时的 `state`，`replayed=true`。
   这可能与当前状态不同；用 GET 确认当前状态，切勿把历史回执视为当前状态。

示例（用实际 GET 返回的 version 替换占位符）：

```json
{
  "expectedVersion": "<GET 返回的64位小写SHA-256版本>",
  "idempotencyKey": "file-105-parse-001",
  "actor": {"type": "agent", "id": "roster-cleanup"},
  "reason": "核对原页后更正段的家数",
  "parts": [{
    "titleCode": "specialized_sme", "eventKind": "review",
    "year": 2021, "batch": 2, "attachment": "附 件 2", "rowCount": 67
  }]
}
```

MCP `save_parse_result` 在上述对象中加 `fileId`。既有精确 `relPath` 别名保留，
与 `fileId` 恰给一个；解析路径后仍绑定稳定 ID、版本及同一文件的幂等键。
新读取/历史工具按稳定 ID 使用。旧无版本写客户端须先调用 `get_file_parse_result`，
增加版本、幂等键和审计说明。文件元数据继续使用既有入口，本能力不接收元数据字段。

## 验证、并发与恢复

- 段称号/事件使用已有白名单。year 为1900–2100整数或null，batch 为正安全整数或null，
  attachment 为不超过500字符的字符串或null，rowCount 为非负安全整数、默认0。
  可空段字段省略归为null。最多1000段；不截断。
- 附件归一后，同称号/事件/年份/批次/附件重复整批拒绝，不求和。任何非法字段、
  未知字段（包括嵌套字段）、非法类型或空操作整批拒绝。MCP 在 toolkit 清除未知键
  之前检查原始 tools/call 参数，保持与 REST 相同的拒绝语义。
- `expectedVersion` 覆盖稳定ID、当前状态/全部段、当前来源派生坐标/行数、移出标志、
  最新维护修订。来源发生变化、回填改变段或同内容先改后恢复，都使旧版本失效。
  展示冲突不作为名录业务判断或拒绝代理声明的依据。
- SQLite immediate 事务内检查幂等键、读取/比较版本、重建段、修改状态并保存回执。
  两个同版本编辑只有一个提交；任何后续写入/审计失败整体回滚。跨进程恢复不依赖缓存。
- 相同文件/幂等键异载荷返回409；同键同规范载荷优先恢复历史成功结果，即便当前版本
  已变化或文件后来移出。不同文件的幂等键互不冲突。规范化覆盖段排序、附件和缺省值。
- REST 400为非法ID/字段/集合；401为未鉴权；404为文件/回执不存在；409为版本、
  幂等键或已移出文件冲突。MCP 参数错误为JSON-RPC -32602，领域失败为工具错误；
  传输信封遵循各自协议，写入语义和成功载荷一致。

## 可读审计与数据演进

`GET /api/files/{id}/parse-result/history` / MCP `get_file_parse_history`：

- `afterId`（默认0）、`limit`（默认20、1–50）返回按receipt ID升序的
  `{fileId,rows,nextAfterId}`，取limit+1判断后续，不计数或全量加载历史。
- 摘要含receiptId、fileId、operation、actor、reason、idempotencyKey、createdAt；
  不默认返回 before/after 大快照和内部请求指纹。
- `receiptId` 显式点读一个属于该文件的完整回执，返回before/after解析快照。
  不得与分页混用。REST查询参数与MCP参数均严格校验。
- 更正或撤回代理声明均追加新回执。原始来源不删除，既有历史不改写。
  旧解析数据不伪造追溯审计，从升级后的首次维护开始记账。

迁移 `0021_parse_maintenance_105.sql` 仅新增回执表、文件/幂等唯一索引、
文件/回执游标索引及出处source_file点读索引；不重写既有文件、OCR、名录或解析段。
没有修改 stored_file 的元数据结构。集成者须按brief保留0021编号，合并迁移journal的
全体条目顺序和时间戳后在干净SQLite验证；本票不生成无关schema快照。

## 验收证据

公共接缝为真实Nuxt HTTP、真实MCP tools/call及隔离SQLite，无内部服务mock。
主测试 `tests/parse-maintenance-105-http.test.ts` 精确映射：

| 验收 | 测试名 |
| --- | --- |
| 稳定ID、REST写/MCP读、相同输出 | `replaces agent segments by stable file ID and reads identical state through REST and MCP` |
| PATCH省略、空数组、派生保留/冲突、文件/OCR/企业事件出处不变 | `state-only PATCH preserves segments while empty replacement restores derived conflicts without side effects` |
| 重复归一坐标、非法/未知字段整批拒绝、边界及默认值 | `rejects duplicate normalized coordinates and illegal batches atomically through both public transports` |
| 竞争编辑、异载荷冲突、同键恢复不覆盖后续、ABA保护 | `rejects stale parallel edits and recovers the original idempotent receipt without overwriting later state` |
| 回执写入失败整体回滚、重试成功 | `rolls back segment and status writes when audit persistence fails and permits a clean retry` |
| 有界摘要、游标、原回执点读/跨文件拒绝、REST/MCP一致 | `pages audit summaries without snapshots and point-reads immutable receipts with REST MCP parity` |
| 鉴权、非法/缺失ID、移出保护、OpenAPI/MCP发现 | `enforces authentication stable IDs and removed-file writes while exposing discoverable contracts` |
| 重启后恢复原回执 | `recovers a committed receipt after an application restart without requiring the old version to remain current` |
| 既有精确路径兼容、按ID共享回执、混用拒绝 | `preserves the existing MCP exact path reference while binding concurrency and receipts to the stable file ID` |
| 来源变化使旧版本失效并刷新冲突 | `invalidates an edit version when source-derived coordinates change and refreshes the visible conflict` |
| 1000段完整写入、1001段拒绝且不截断 | `accepts the complete segment limit and rejects over-limit replacements without truncation` |
| 同键并发重试仅一个回执 | `coalesces simultaneous same-key retries into one durable parse receipt` |
| 无关数据增长下固定ID/固定页不变 | `keeps fixed-ID reads and history pages unchanged as unrelated evidence OCR and receipts grow` |

红绿日志在Git外 `/tmp/ningbo-spec98/ticket-105/`：
`red-1.log` 为未接入路由前415；`red-path.log` 为恢复旧MCP路径支持前400；
`red-version-mutation.log` 为临时移除版本保护后并发结果[200,200]使预期[200,409]失败。
错误实现已恢复，不保留mutation。首次完整通过记录见`green-complete.log`。
集成tip `142c15a096513012e8b9f424e2cba70af82d3cc3` 已合入本分支，
验证源码提交为 `6714827799d31e23701b6bbb7908289253e44133`（实现提交 `bc9aa99`）。
该提交上顺序完成的最终门禁全部退出0：

- `pnpm test tests/parse-maintenance-105-http.test.ts tests/mcp-surface.test.ts tests/file-parts.test.ts tests/stored-file.test.ts tests/files-openapi-contract.test.ts --maxWorkers=1`：
  5文件通过、106测试通过、2跳过；其中本票13测试全部通过。两条跳过来自既有
  `stored-file.test.ts` 的真实files库缺失分支，不是本票测试跳过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `git diff 4f910f6..HEAD --check`：通过。

最终日志为`final-tests.log`、`final-typecheck.log`、`final-build.log`，
源码SHA独立记录在`final-source-sha.txt`。后续仅补本文验收记录，不改变已测执行源码。
本次没有运行全仓套件；集成父代理负责全规格门禁与审核。

## 性能敏感路径与限制

固定ID读取只投影目标stored_file、目标段和最后一条审计ID；当前出处按source_file索引
联接后聚合。写入只删除/重建目标文件的段；派生读取也位于事务内。没有全库raw载入、
OCR读取或全库回填。历史列表为(file_id,id)索引游标及显式轻量字段；只有单receipt点读
载入解析快照。幂等定位为(file_id,idempotency_key)唯一索引。

有界性用例将无关出处1000→5000、无关OCR页/回执各100→500（每项约8KiB原文/快照），
每档5组真实HTTP状态+历史页读取，另经MCP核对相等。输出内容/版本保持不变，历史页
小于256KiB且不含无关原文；SQL计划单独记录在`boundedness.jsonl`，不是私有函数断言。
这是定向合成样本，不是完整业务分布1x/2x/5x、容量验收或受控1vCPU/4GiB保证。
未运行生产写入、部署、全规模性能对照、浏览器/UI或长时间混合负载；本票不改UI。

最终源码提交 `6714827799d31e23701b6bbb7908289253e44133` 的同一用例观测：
Node24.22.0/macOS27.0.1/Apple M4，无容器限额、存在其他并行工作。
1000条无关出处档，5组HTTP状态+历史页合计耗时中位数13.658ms，范围8.969–32.761ms；
5000条档，中位数20.333ms，范围9.168–24.985ms。每组含两次请求和测试断言，
不是纯服务耗时；不计算或宣称可靠p95/p99、不推导倍数提速。原始样本为
`boundedness.jsonl` 最后一行，独立于此前未提交工作区的探索样本。
计划明确显示出处按 `record_evidence_source_file_105_idx (source_file=?)` SEARCH，
历史按 `file_parse_105_history_idx (file_id=? AND id>?)` SEARCH，事件/记录使用主键点读。
新增出处索引有迁移建索引锁和持续写放大成本，本票未在完整业务分布上量化这些成本。
