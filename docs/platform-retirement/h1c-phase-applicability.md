# #744 简化迁移就绪检查

用户最新裁定替代先前 A1/A2 防篡改契约，不再按 A2a/b/c/d 逐层拆分。旧报告/FAIL/提交是历史证据，不删除也不重新定性。

- H1c71611：必要 correspondence.observation_id、observation.id/collection_id 存在，H1c迁移状态完成。
- process71610/71611、recognized/witness71609–71611：各自必要列存在，相关迁移状态完成；无递归 catalog/receipt/hash 验证。
- 查询只读必要表列和小型 migration 状态，不枚举整库schema或逐条比较trigger文本。
- 来源writer、capture、业务fingerprint、bootstrap、collection command/replay支持完成的71611目标；原输入、原字段、去重及失败回滚沿用现有业务实现。
- 临时空DB仅用于独立重算业务指纹。复制实际schema和迁移状态使现有writer可执行；无权限注册、catalog/ledger认证或反向DDL重建。
- FK/schema/完整性/行数/关键字段/原字节核对归离线迁移完成步骤。fingerprintArchiveInventory保留为离线检查，不再放在普通指纹请求路径。
- 普通runtime及三worker guard不放宽，declarations仍为71608。H1b display和两correspondence detail消费者未全面接线；实际离线FK转接未实施。

本候选保留业务 archive byte/hash、source identity、assignment/revision、stored/uncaptured、replay冲突与SQL约束；这些不属于被移除的任意DB篡改防御。
