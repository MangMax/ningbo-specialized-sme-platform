# 终态运行集成进度

2026-11-14，本地集成：正常 reconcile、三来源读、企业归并、差异明细/汇总与真实 worker 已接入目标模型。`upgrade/retire-platform-model.ts` 在隔离副本核对迁移与历史原档后，事务删除九张旧表并记录终态完成标记；终态启动不执行 expand 迁移。

企业归并保留历史 identity、原归属修订与事实命名空间，追加当前归属与 identity redirect；后续旧 ID 写入解析到当前企业。当前列表排除被归并 identity。

验证：企业归并 3 项、物理退役/启动/worker 4 项、三来源详情 1 项通过。差异测试验证 full/scalar 对照，以及删除旧表前后的 REST 列表结果不变；其坐标与旧服务一致。完整 Nuxt/Nitro 构建通过，打包实例上企业列表、三来源列表、三称号当前名单和差异列表八个 HTTP 请求全部 200。所有数据为合成隔离夹具，不构成真实数据性能证据。

服务器类型检查仍有 26 条既有 MCP/日志诊断，本批新增诊断已修复。

2026-11-14 后续修复：覆盖评估不再把 legacy_supplement 的分页信息提升为原查询完整性断言。完整旧/新差异列表对照（含 queryCoverage/explanationValidity）已通过；比较服务相邻回归 31 PASS、1 SKIP。初始差异诊断 differences09.json 仍保留，修复结果见 coverage11.json、coverage12.json。

仍待完成：源码内历史分支整理、完整真实数据升级与业务回归、MCP/真实工作簿及同源性能验证。生产切换未执行。

仓外证据：`/Users/mang/.t3/acceptance/platform-complete-migration/reconcile-slot-capture/target-final-integration/combined/`。首轮失败、修复后结果与构建日志分别保留。

## 终态原生建库与完整升级入口

`initializeDb({ create: true })` 在新路径直接创建终态结构；显式 migrationsFolder 及 db/client 的旧 setup 适配器保留给历史工具。公开 db/index.useDb 和应用启动只接受终态。新库的 capability 声明与历史迁移记录分开，platform_migration_run 保持空表。指纹校验临时模型复制 capability，不伪造历史迁移记录。

`db/runtime-schema.generated.ts` 仅包含已退役结构的 DDL，通过 upgrade/generate-runtime-schema.mjs 生成，无业务行、凭据或源文件内容。初始化、首笔平台导入、来源读取、重启、schema0 公共入口拒绝及相邻检查 14 PASS。

`upgrade/run-complete-platform.mjs` 串行组合既有迁移，只复用一份 predecessor 快照；新目标必须不存在。完整链的全库 integrity_check 由最终退役事务执行一次，各独立升级命令仍保持原检查，阶段回执明确记录 deferred/full，不把待验证阶段标成全库已通过。外键强制和各阶段源值/映射检查保留；重复的全库外键扫描合并到最终退役事务，独立命令仍执行原扫描。完整合成链已跑通；真实历史备份迁移正在仓外隔离副本验证，未获完成结论。

完整链已补齐旧备份的 expand 前置准备、显式断点续跑和冻结源 SHA 共享缓存（设备/inode/大小/mtime/ctime 变化即重读，退役前强制整文件 SHA）。投影 manifest 跳过未被该阶段修改的对应关系、对应关系审计、导入回执和任务大正文；对应关系及审计仍由其独立迁移 owner 逐字节核验。完整链内已完成且来源绑定一致的 T04/T05a 不再被下一步逐行重演，仍核对 checkpoint/源行数/目标及别名行数；独立升级命令保留原逐行重演。

原值比较与回执摘要改为有序流式处理，避免整表 HEX/JSON 常驻内存；摘要序列化格式保持原样。同一连接无写入时复用 manifest，SQLite total_changes、data_version 和 schema_version 变化即失效，逐行输出的审计始终重新读取。对应关系转换在完整链且无外部 trigger/view 引用时使用事务内 rename/copy/drop，避免额外大 TEMP 副本；其他情况保留原转换。

本轮验证：最新完整合成链完成，除迁移控制表外，71 张业务表的行数与 SQLite 单元格字节摘要全部一致；退役/重启/worker 相邻 6 PASS；manifest 复用的本地写入、外部提交及 DDL 失效检查通过。离线入口严格类型探针的升级所属诊断为 0，依赖图仍有 39 条既有诊断，不能称全仓类型检查通过。真实历史备份仍在升级，尚无真实业务回归或性能结论。

企业详情证据读取已识别 reconcile-slot T04 的完成标记，保留相同原档字段集合和 lifecycle 核验，修复迁移后详情的 Unknown provenance lifecycle。终态详情忽略历史 typed-read 回退设置，部署示例移除两个已退役的平台回退变量；原生首笔导入和迁移后详情的两项定向回归通过。首轮失败与修复结果分别保存在 detail-retired-selector.json / detail-retired-selector04.json。
