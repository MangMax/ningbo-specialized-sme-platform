# #104 文件元数据、显示名、移出与恢复

范围：文件资源维护（M）。不修改解析/OCR 业务规则，不重导正式事件，不操作生产资料。原路径、文件 ID 与 `record_evidence.source_file` 关联保持稳定。新入口复用既有分类、显示名和文件服务。

## 公开契约

| 行为 | REST | MCP |
| --- | --- | --- |
| 元数据或显示名 | `PATCH /api/files/{id}` | `update_file`；原 `set_file_category` 继续可用 |
| 软移出 | `DELETE /api/files/{id}` | `remove_file` |
| 恢复 | `POST /api/files/{id}/restore` | `restore_file` |
| 修订与有界历史 | `GET /api/files/{id}/maintenance?page=1&pageSize=50` | `get_file_maintenance` |

原注册 `POST /api/files/register`、列表、`get_file` 和文件预览继续使用原服务。MCP 用 `fileId` 或 `relPath` 恰给其一；REST 用稳定 ID。新增维护读取不触发全库磁盘扫描。历史按修订升序，页大小 1–100；越界或非法分页返回 400，空页返回空数组，不截断原文。

PATCH 白名单仍为 `source/kind/year/batch/titleCode`，或单独 `displayName`（沿用旧入口互斥规则）。未提供不改，元数据 `null`/空串清空；显示名须非空、最多255个 Unicode 字符，不能含控制字符。数字和合法数字字符串保持兼容，数组/布尔等不隐式转数。不能写路径、磁盘字节、哈希、解析状态或分类状态。显示名不参与磁盘定位，不改变 OCR、解析段或正式出处。

## 两种明确的协议

**Legacy 适配**：基线 `4f910f612cfdf6915758f39522f0ff9874f96d7a` 的 REST PATCH、DELETE（无 body）、注册载荷和 MCP `set_file_category` 继续可用，响应不加封套或修订字段。旧 REST 文件管理口沿用既有本地无 token 策略，旧 MCP 写口仍要求 MCP token。没有现代控制字段的旧写入是 blind write：不做预期修订检查、不提供按键重放保证；保留既有元数据空 PATCH 和已移出文件的 REST 元数据更新语义。旧 MCP 对已移出文件的写入限制不变。

这条兼容通路不推断身份或确认依据：新增历史标记 `mode=legacy`、`actor=null`、`basis=null`。实际元数据、显示名、移出或同路径注册刷新会在同一事务中推进维护修订，使已读取的现代修订失效。无实际变化的无键重试不追加虚假变更；已移出时间保持稳定。历史不会反向补造迁移前的操作者或依据。

**Versioned 命令**：只要旧入口出现任一现代控制字段，四项必须齐全；部分封套返回400，不能降级到 legacy。三个新增 MCP 写工具和 REST 恢复一律要求完整四项：

```json
{
  "expectedRevision": 3,
  "idempotencyKey": "file-42-correction-1",
  "actor": "reviewer-id",
  "basis": "已核对的原文件或维护依据"
}
```

REST PATCH 在同一对象附上元数据字段；MCP `update_file` 把字段放进 `patch`，控制字段放顶层。actor 和 basis 是调用者声明，不是认证系统证明的身份或用户确认。actor/key 最多200字符，basis最多2000字符。版本化 REST 写入需要 API token，MCP 写入需要独立 MCP token；未配置或缺失凭据不能写入，未鉴权 MCP 不展示新增写工具。新/版本化元数据写入拒绝已移出文件，须先显式恢复。

旧修订、同键异请求、磁盘事实冲突返回409；相同完整请求的同键重试跨 REST/MCP 不再修改或追加历史，并返回当前文件状态。历史保留原请求的前后值，重试不会重演已被后续操作替代的状态。幂等键在文件维护范围全局唯一，请包含调用方命名空间。不同文件/行为也不能复用同键。错误不覆盖已有文件或审计。

## 恢复和磁盘删除

恢复流式计算原路径 SHA-256，并核对字节数、普通文件、根内真实路径及哈希期间 inode/mtime/ctime；缺失、目录、目标文件为符号链接、内容变更均拒绝。提交事务再次核对维护修订、已移出状态和登记磁盘事实。原文件已处于有效状态时仍核验磁盘事实；相同状态重试不重导事件。恢复不刷新登记哈希来迁就不匹配的磁盘文件，也不重建解析或 OCR。

软移出仅标记 `removed_at`，磁盘字节及正式出处仍可读取，扫描不会自动复活。MCP `remove_file` 没有磁盘删除参数或能力。既有独立 `?deleteDisk=1|true` 仍须调用方明确请求；只在旧独立删除协议下支持，不接受现代维护幂等键，不与软移出键混用。正式出处引用数大于0时409拒绝。引用检查和短小的文件系统元数据删除在 SQLite 写锁内执行，避免数据库引用写入在检查后插入。磁盘物理删除不可撤销；文件系统删除和数据库最终提交无法构成跨介质原子事务，不把它描述为可恢复操作。

迁移 `0020_file_maintenance` 增加独立、追加式维护审计/幂等回执；合入 #105/#106 后，将本票 journal 条目追加到现有0021/0022之后（idx22、when1792400021001），不改已存在条目的时间戳，确保已应用当前 integration 迁移的库也会执行0020。不能按文件名前缀把新条目重新排到已应用迁移之前；原 `stored_file_audit` 显示名历史保留。元数据、旧显示名审计与新维护审计在同一事务内提交，追加失败则全部回滚。新历史只保存有界元数据快照，不存 OCR、来源原文或凭据。

## 验证与证据

测试文件：`tests/file-maintenance-104-http.test.ts`。真实 Nuxt HTTP、MCP `tools/call`、独立 SQLite 和临时文件库；夹具先应用当前 integration 已有迁移（包括0021、排除本票0020），再由真实应用启动执行本票迁移，覆盖已有集成库升级；另有既有文件测试覆盖空库完整迁移；随机独占端口、独立 Nuxt buildDir，`maxWorkers=1`。仅夹具准备及故障注入使用直接数据库操作，业务结果经公开读取验证。

| 验收 | 精确测试名 |
| --- | --- |
| 基线载荷、旧响应、旧写入使现代版本失效 | `accepts exact baseline REST and MCP payloads and invalidates modern revisions after legacy writes` |
| 部分现代封套拒绝 | `rejects partial modern envelopes without downgrading to legacy blind writes` |
| OpenAPI 可发现 | `publishes the shared maintenance controls, restore operation and bounded history in OpenAPI` |
| HTTP/MCP 元数据、改名、移出和恢复对等 | `updates display name and metadata and removes and restores through MCP with HTTP readback` |
| 修订竞争、跨传输幂等、异请求冲突 | `serializes competing revisions and replays a cross-transport key without duplicate audit` |
| 移出/恢复重试和历史读回 | `keeps remove and restore retries stable and reads their complete audit through either transport` |
| 鉴权隔离和工具发现 | `rejects unauthenticated external writes and keeps new MCP writes undiscoverable without its own token` |
| 原 ID/路径/字节恢复 | `restores the same file identity after soft removal without changing original bytes` |
| 恢复磁盘失败分区 | `rejects missing, modified, directory and symlink restore targets without changing removed state or audit` |
| 白名单、非法目标、审计故障原子回滚 | `rejects protected fields and invalid targets and rolls back display audit if maintenance audit fails` |
| 出处/OCR/解析段和引用保护 | `protects referenced disk bytes and preserves formal evidence, OCR and file parts across the lifecycle` |
| 独立明确磁盘删除 | `requires explicit disk deletion, records the soft removal and refuses restoration once bytes are gone` |
| 有界历史及无关数据增长 | `bounds history pages and preserves exact read size when unrelated audit and OCR data grow` |

Git 外日志 `/tmp/ningbo-spec98/ticket-104/` 保存 red/green、回归、类型检查及最终源码 SHA。初始 restore 夹具有路径声明不符，修正后 `red-restore-valid.log`/`green-restore-valid.log` 才是有效红绿；不使用最初错误夹具证明功能缺失。移除“部分封套拒绝”校验的定向 mutation 在真实 HTTP 返回200，测试按预期转红（`red-partial-envelope-mutation.log`）；恢复校验后重新运行完整目标矩阵。另将0020时间戳回退到0021之前，真实应用在已有0021的库上跳过本票迁移，基线载荷回归按预期转红（`red-integration-tip-upgrade.log`）；保留追加顺序后转绿。兼容提醒后的最终契约以上述 legacy/versioned 区分为准，早期 `green-auth.log` 等仅为历史过程，不是最终鉴权验收。

有界性样本：目标5条审计、页大小2；另加入500条无关审计（100万依据字符）和557056字符无关 OCR。10次目标读取与加入前内容完全相同，分页覆盖最后页和空页；记录真实响应字节与延时在 `boundedness.json`。使用 `(file_id,revision)` 唯一索引及幂等键唯一索引；无全表原文读取。此为小型隔离夹具的查询边界证明，不代表2x/5x完整业务分布、部署容器容量或性能 SLO 验收；重型基线/候选测量由集成线程串行负责。

未重建 UI，因此不宣称桌面/390px视觉验收；未部署、合并 main 或触及生产数据。共享冲突面为 schema、迁移 journal、MCP 写名单/说明和既有文件适配器，集成时保留其他票的条目并协调迁移顺序。
