# #744 correspondence 离线转接

仅操作已停写维护窗口生成的独立合成/维护副本；生产执行另行批准。普通runtime和worker仍拒绝非零phase。

1. 停止提交并排空任务，保留原备份；用已有 `upgrade/run-snapshot.mjs SOURCE SNAPSHOT EVIDENCE` 获取包含已提交WAL的一致快照（参数以该工具usage为准）。前驱必须是完整71610。
2. 把固定快照独占复制为另一个 target 文件；不得覆盖已有文件、源文件或同inode硬链接。两者保持 standalone，无writer，磁盘可用量至少8GiB。
3. 使用Node24.22.2和 `JITI_FS_CACHE=false node upgrade/run-correspondence.mjs FIXED_SOURCE_71610 INDEPENDENT_TARGET NEW_EVIDENCE_DIR RUN_ID`。证据目录必须不存在；工具不修改源、不建立在线lock owner。目标必须是源的未改动副本，或相同run已完成的目标。
4. 查看 `before.json` 与 `receipt.json`（失败则 `failure.json`）。缺失alias/原dangling FK以具体行报错，不能丢弃或补造。目标原表DDL、索引、trigger和入向FK在离线扫描；仅已知audit入向owner重建，未知入向owner报错。
5. 一次事务复制原20列、映射唯一变更列、重建audit与原索引/trigger、保留sequence；全量业务字节对照、FK及integrity通过后，提交71611和迁移完成日志。任何失败均整体回滚，可原run重试；不要用旧快照覆盖已经产生新业务写入的完成目标。

原 correspondence/audit PK、业务字段、serialized JSON/原空白、fingerprint和所有旧外部ID引用不变；NULL保持NULL。新物理列 `observation_id` 指向观察，详情通过alias返回旧relation ID，不合并共享record/version的不同观察。迁移完成日志只供状态/恢复，不形成请求认证链。源快照/原回执均保留。

此工具不删除其他旧表，不修改普通expand ORM或Drizzle迁移目录，不切换公开来源/授权/有效资格/年度逻辑。完整退役仍须迁移其他consumer及独立生产验收。
