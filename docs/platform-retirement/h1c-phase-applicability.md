# #744 简化迁移就绪检查

用户最新裁定替代先前 A1/A2 防篡改契约，不再按 A2a/b/c/d 逐层拆分。旧报告/FAIL/提交是历史证据，不删除也不重新定性。

- H1c71611：必要 correspondence.observation_id、observation.id/collection_id 存在，H1c迁移状态完成。
- process71610/71611、recognized/witness71609–71611：各自必要列存在，相关迁移状态完成；无递归 catalog/receipt/hash 验证。
- 查询只读必要表列和小型 migration 状态，不枚举整库schema或逐条比较trigger文本。
- 来源writer、capture、业务fingerprint、bootstrap、collection command/replay支持完成的71611目标；原输入、原字段、去重及失败回滚沿用现有业务实现。
- 临时空DB仅用于独立重算业务指纹。复制实际schema和迁移状态使现有writer可执行；无权限注册、catalog/ledger认证或反向DDL重建。
- FK/schema/完整性/行数/关键字段/原字节核对归离线迁移完成步骤。fingerprintArchiveInventory保留为离线检查，不再放在普通指纹请求路径。
- 普通runtime及三worker guard不放宽，declarations仍为71608。H1b display支持完成的71611；process/recognized detail按目标 observation FK 查询并反向映射原外部 relation ID。

本候选保留业务 archive byte/hash、source identity、assignment/revision、stored/uncaptured、replay冲突与SQL约束；这些不属于被移除的任意DB篡改防御。


## #744 实际转接候选

固定前驱为完整71610目标快照，后继为71611。`upgrade/correspondence.ts` 在独立副本的一个 IMMEDIATE 事务内重建当前 correspondence 和必要的 audit 入向FK表，其他旧表保留。非 NULL relation_id 必须经现有 alias 映射到真实 observation；缺失则列出 correspondence PK、原 relation ID、映射 observation ID 并整体失败。NULL不补造，audit/serialized references仍保存原外部ID及字节。主键、AUTOINCREMENT高水位、约束和索引保留。

运行入口见 [离线操作](h1c-correspondence-offline.md)。离线完成核对全部业务单元格（仅将目标 observation_id 逆映射回原 relation_id 比较）、FK、完整性、原迁移日志与sequence；写完成状态后才支持71611读写。事务内任一步失败返回完整71610，原固定快照保留用于重试。完成的同源同run重放只返回完成状态，不从快照覆盖后续业务写入。

| 入口 | 前驱/后继行为 |
| --- | --- |
| process detail | 原71610查询保留；完整71611使用typed observation FK和反向alias；DTO仍返回旧relation ID |
| recognized detail | 原71609/71610查询保留；完整71611同上；不改变版本/观察/归属含义 |
| H1b evidence display | 原71610及完整71611；查询中移除T04 receipt证明预加载，保留真实归档/未捕获/NULL/脱敏规则 |
| H1a evidence | 不再以T04 receipt、hash长度或旧ID相等作为来源存在证明；仍以来源生命周期和实际归档字段区分缺失/未捕获 |
| 业务writer/fingerprint/collection replay | 复用既有完整71611支持；本候选用实际转接副本代替受控DDL后继验证 |
| 普通runtime/三个worker | 非零phase仍拒绝；无公开切换 |
| declarations | 仍为原71608边界，本候选未扩展 |

废止的运行要求是任意catalog/receipt篡改防御、递归scratch认证、来源receipt存在证明。历史报告及FAIL原件保留。业务原档hash、fingerprint/去重、原字段语义、事务/FK/备份与离线数据核对继续有效。

更大迁移尚余：普通 correspondence decision/read/write、年度/范围证明/其他旧relation/query消费者，以及全项目旧表移除、公开入口切换和生产执行。本切片的两个detail读者可用不代表这些消费者已兼容71611。

## #749 difference reference successor

完整 71611 的独立副本可由 [差异引用离线工具](difference-references-offline.md) 转为 71612。同一 difference_reason 的两列物理证据 FK 转向 collection/observation；公开读回仍使用外部别名。既有接受的 explicit target 服务延续至完成的 71612，按必要列与相关完成状态就绪。完整 schema/FK/PK/行/sequence/业务字节核对在离线完成时执行。原 migration 日志不改写。普通 declarations、runtime 和三个 worker 边界保持原状；decision-lifecycle、113/114、refresh 写业务及旧表 DROP 仍由后续 owner 承接。
