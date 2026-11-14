# 终态运行集成进度

2026-11-14，本地集成：正常 reconcile、三来源读、企业归并、差异明细/汇总与真实 worker 已接入目标模型。`upgrade/retire-platform-model.ts` 在隔离副本核对迁移与历史原档后，事务删除九张旧表并记录终态完成标记；终态启动不执行 expand 迁移。

企业归并保留历史 identity、原归属修订与事实命名空间，追加当前归属与 identity redirect；后续旧 ID 写入解析到当前企业。当前列表排除被归并 identity。

验证：企业归并 3 项、物理退役/启动/worker 4 项、三来源详情 1 项通过。差异测试验证 full/scalar 对照，以及删除旧表前后的 REST 列表结果不变；其坐标与旧服务一致。完整 Nuxt/Nitro 构建通过，打包实例上企业列表、三来源列表、三称号当前名单和差异列表八个 HTTP 请求全部 200。所有数据为合成隔离夹具，不构成真实数据性能证据。

服务器类型检查仍有 26 条既有 MCP/日志诊断，本批新增诊断已修复。

未解决：完整旧/新差异列表对照发现历史混合范围样本 queryCoverage/explanationValidity 不一致，诊断保留于 differences09.json；目前只确认该列表坐标与旧服务一致、目标模型结果在旧表删除前后不变。不能将该检查称为完整业务语义一致。

仍待完成：源码内 schema0 分支与旧选择器退役、新库直接创建终态结构、完整真实数据升级与业务回归、MCP/真实工作簿及同源性能验证。生产切换未执行。

仓外证据：`/Users/mang/.t3/acceptance/platform-complete-migration/reconcile-slot-capture/target-final-integration/combined/`。首轮失败、修复后结果与构建日志分别保留。
