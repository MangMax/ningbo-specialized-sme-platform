# #99 企业别名维护

范围：企业别名的显式确认、更正、撤回、恢复和精确历史。没有自动判断、物理删除来源、生产写入或 UI 改动。企业身份仍使用专门的补统代/归并操作。

## 公开契约与代理操作

REST 与 MCP 调用同一 `server/utils/alias-maintenance.ts` 服务，读不鉴权，REST 写需 API token，MCP 写需 MCP token。所有新 REST 响应为 `no-store`，MCP 沿用现有 `no-store` 中间件。

| REST | MCP | 行为 |
| --- | --- | --- |
| GET `/api/roster/enterprises/:id/aliases` | `list_enterprise_aliases` | `status=all/pending/confirmed/withdrawn`；默认 all；按稳定别名 ID 升序 |
| GET `/api/roster/enterprises/:id/aliases/:aliasId` | `get_enterprise_alias` | 精确企业和别名 ID；归属不符 404 |
| GET `/api/roster/enterprises/:id/aliases/:aliasId/history` | `get_enterprise_alias_history` | 精确别名的全部决策，按审计 ID 升序分页 |
| PATCH `/api/roster/enterprises/:id/aliases/:aliasId` | `maintain_enterprise_alias` | 显式确认、更正或撤回 |

列表/历史 `page=1..1000000`，`pageSize=1..50`，默认 20；返回 `{rows,total,page,pageSize}`。页边界/未知参数报 400；没有目标报 404；空结果明确返回空数组。单页超过 256KiB 报 413，调用者减小页大小完整读取；不截断原名称、备注或审计。SQL 先范围过滤和分页，只做同范围标量计数；不读取平台原始响应和关系原文。

先读精确别名取得 `version`，再提交：

```json
{
  "action": "confirm",
  "expectedVersion": 1,
  "actor": "agent:roster-check",
  "basis": "已核对所引用的平台关系及该企业统代、qymc",
  "idempotencyKey": "alias-123-confirm-v1"
}
```

MCP 另带 `enterpriseId`、`aliasId`，其余载荷一致。成功返回 `{alias,replayed}`；冲突返回 REST 409 / MCP tool error，非法字段或证据为 400 / tool error。缺少授权的 MCP 写调用为 HTTP 401，未授权 discovery 不显示写工具。

- `confirm`：`pending/withdrawn → confirmed`；同 ID 恢复必须显式确认并给当前版本；已经 confirmed 用新键再次确认报状态冲突。
- `correct`：仅接收 `changes`，允许 `name/sourceKind/sourceRefId/validFrom/validTo/note`；必须实际改变字段。保持当前核验状态，包括 withdrawn，不隐式恢复。没提供的字段保持，`null` 仅清除 `validFrom/validTo/note`；不接受 enterpriseId、身份、状态和派生字段。
- `withdraw`：`pending/confirmed → withdrawn`；同 ID 和全部来源保留。已撤回用新键再撤回报冲突。错误旧证据也能显式撤回，不要求再次证明错误事实。
- 每种操作必须有目标、`expectedVersion/actor/basis/idempotencyKey`。版本更新和审计追加为同一 immediate SQLite 事务，审计失败回滚别名；无任何提交前共享缓存更新。
- 幂等键按别名范围唯一；同键、同归一化载荷返回首次决策快照，版本可以已前进，不追加审计；不同载荷报冲突。重放响应不是当前状态，应另读精确别名。

平台来源重用既有导入的精确投影与校验器，要求真实关系、正确接口、逐字 qymc、企业统代和关系归属一致。`manual` 使用 `sourceRefId=0`，依据放 basis。维护 API 中 `announcement.sourceRefId` 定义为经信局 `source_document.id`，须由该企业相同 `record.nameRaw` 的事件出处支持；不从文件标题猜身份。确认或更正有效别名时，其他企业现名/已确认别名的归一化同名冲突报 409。不会自动跨企业归并。

## 原值、来源与导入兼容

迁移 `0015_alias_lifecycle` 新增 `version` 默认 1、可空 `originalName/originalSourceKind/originalSourceRefId` 并回填已有数据，新增追加审计和分页索引。可空策略兼容既有导入/归并/资料维护插入；查询对尚未维护的新插入使用当前值作为原值，首次维护原子冻结原值。更正仅改变当前解释，原名称与原来源一直可取，历史含每次 before/after 的稳定别名与企业 ID。

同自然键导入仍执行原有 skip；不会替代维护，也不会重确认 withdrawn。公开导入创建后可按稳定 ID 确认、撤回、同键重导、再显式恢复。#96 对同键 withdrawn 旧名应明确拒绝冲突，不静默确认；资料审计仍归 #96。

有效搜索和匹配的既有 SQL/读模型/库内身份字典均只使用 `confirmed`。撤回因此立即退出 REST/MCP 企业搜索与库内匹配候选；平台原始关系、查询原文、公布记录/出处和旧审计不删除。新接口不触发外部平台查询。

## 专门归并操作的窄兼容

公开 import merge 仍使用既有事务和幂等批次：

- 无自然键冲突：别名稳定 ID 和版本保留，只改当前归属；所有旧审计字段完全保留。
- 自然键冲突：在同一归并事务中，只将被并别名历史的查询 `aliasId` 改指保留别名，再删除重复别名。审计行 ID、原 enterpriseId、before/after（包含原始 alias/enterprise IDs）、请求 hash/key、actor/basis/time 都不改。按受影响 aliasId 索引更新；不装载全局审计或其载荷。
- 两侧存在相同审计幂等键，即使 hash 相同也报 `merge_alias_audit_key_conflict`，保留两条历史并整批不写。不能为满足唯一键删审计。
- 有审计的状态不一致，或任一为 withdrawn 的状态不一致，报 `merge_alias_lifecycle_conflict`。无审计的既有 pending/confirmed 折叠行为保留；不把新生命周期冲突静默恢复。预检和执行都检查，执行也检查本批新生成的冲突。

旧企业 URL 在企业归并删除后 404；被折叠的旧别名 URL 也 404，不提供重定向。改用规范企业 ID 与保留别名 ID 查询所有历史；非冲突移动仍使用原别名 ID。以保留 ID 重放被折叠决策返回其原始快照（原 IDs），不会伪装成新状态。归并批次本身同键重放不重复迁移历史。历史中版本属于各原始别名，不是跨别名统一重排的版本号。

## 验收证据

测试均走真实 Nuxt HTTP 与 MCP `tools/call`，独立临时 SQLite；数据库写入仅用于合成初始夹具和明确的审计故障注入。行为核对只读公开接口。测试服务端口动态隔离，maxWorkers=1。

| Requirement | Evidence |
| --- | --- |
| 待核/确认/撤回和精确有界历史、原值来源 | `lists pending aliases by stable enterprise and alias IDs then confirms with version and exact bounded history`；`corrects and withdraws without changing original facts then explicitly restores the same stable alias` |
| 撤回退出有效搜索与匹配，原档保留 | 上一生命周期测试；`withdrawal excludes aliases from the public identity matching plan while retaining platform originals` |
| 来源/主体/字段/目标/边界拒绝且无变更 | `rejects invalid evidence and subject conflicts without changing version or history`；`corrects source references using import identity validation and preserves the original name and source`；`accepts announcement provenance only for the same enterprise original name and rejects wrong USCC evidence` |
| 并发版本、精确重放、事务失败恢复 | `serializes competing versions and replays the exact decision while rolling back audit failures` |
| 导入创建与同键恢复 | `maintains imported aliases explicitly and same-key reimport preserves withdrawal until versioned restore` |
| REST/MCP 对等、鉴权、OpenAPI | `exposes authenticated MCP lifecycle tools and equivalent bounded REST reads with public OpenAPI` |
| 归并保留审计、冲突回滚和重放 | `moves audited aliases without a clash and folds clash histories without losing immutable decision provenance`；`rejects alias merge key collisions even with equal hashes and rolls back unrelated batch writes`；`rejects withdrawn versus confirmed merge clashes and recovers the same failed batch only after explicit decisions`；`rolls back earlier alias moves and creations when the merge itself introduces an audited lifecycle clash` |
| 无关数据增长、响应页预算 | `keeps fixed pages and exact history unchanged as unrelated aliases, audit rows and raw archives grow`；`rejects oversized alias and history pages explicitly so callers can fetch every row with smaller pages` |

红绿日志在 Git 外 `/tmp/ningbo-spec98/ticket-99/`：确认缺路由、correct 尚不支持、MCP 尚不存在、审计 FK 阻止折叠、归并缺冲突保护、过大页仍 200，分别先观察失败再实施。其余既有校验通过覆盖验证。旧失败日志不改写成通过。

### 性能证据边界

合成缩放测试增加 100/200/500 个无关别名、同数量审计和原始平台查询，原文为固定重复载荷；目标企业页和目标历史页逐字一致、不含无关原文。每级 5 次本机真实 HTTP 列表+历史顺序读取，仅观察耗时和响应字节；不能据此推断完整业务分布的 2x/5x 容量、尾分位、内存/事件循环 SLO 或生产性能。没有在并行工作期间运行大规模基准。最终实际命令、执行源码 SHA 和测量文件见后续交付记录。

### 本票交付验证

执行源码 `0b5b0da635e8afbaa347330606fc8790720c0785`（实现提交 `9519851` 加集成 tip `142c15a`）。后续本票证据文档提交不改变执行源码。

- `ALIAS99_MEASUREMENTS=/tmp/ningbo-spec98/ticket-99/measurements-0b5b0da.json pnpm test tests/alias-maintenance-http.test.ts tests/mcp-surface.test.ts tests/roster-import-api.test.ts tests/roster-duplicate-merge.test.ts tests/enterprise-read-http.test.ts tests/uscc-research.test.ts --maxWorkers=1`：6 文件、244 测试通过，其中本票真实 HTTP/MCP 15 测试；退出 0，日志 `verification-0b5b0da.log`。
- `pnpm typecheck`：退出 0，日志 `typecheck-0b5b0da.log`。
- `git diff --check` 通过。未运行本票 head 的生产构建、全仓测试、浏览器 UI、生产请求或受控资源/完整业务分布压测；最终集成由父线程验证。这些未运行 lane 不借用历史通过结果。

以上原始日志和测量 JSON 都在 Git 外 `/tmp/ningbo-spec98/ticket-99/`。本机 Node24.18.0（Vitest 运行时）、macOS，其他工作者并行运行；没有容器资源约束。每个样本是目标列表页 + 精确历史页顺序真实 HTTP 完整读取的合计耗时：

| 无关合成规模 | 别名/审计/查询各增至 | 平台原文总字节 | 样本数 | 中位 ms | 范围 ms | 列表/历史响应字节 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 1x | 100 | 1000000 | 5 | 5.527 | 4.925–6.560 | 1061 / 1083 |
| 2x | 200 | 2000000 | 5 | 9.472 | 5.439–12.183 | 1061 / 1083 |
| 5x | 500 | 5000000 | 5 | 7.482 | 5.461–12.110 | 1061 / 1083 |

这是小型合成无关数据增长的可观察证据，不是“性能提升倍率”或可靠尾延迟。查询使用企业/状态/别名 ID 索引、历史 aliasId 索引和幂等唯一索引；归并审计只按受影响 ID 检查或更新。只证明这些固定页和原文隔离行为，没有证明部署容量或全部性能预算。
