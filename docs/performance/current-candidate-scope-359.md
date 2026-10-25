# 当前资格候选页范围（#359）

`currentCandidateSql` 由当前资格查询与工作簿的完整候选计数、枚举共用。平台分支在本次 SQL 内投影已归属关系及其查询元数据；安全页数组按 query 计算累计范围，每条关系只投影一次称号。四个来源的 UNION、去重、归属、未知称号 fallback 及调用者排序不变。请求关键词和分页不参与候选缩小。

快速路径只用于多 rdjb、有效 JSON、对象页数组，且每个成功页的 fetchedCount 为 `[0,2147483647]` 内的 JSON 整数，数组长度亦不超过 2147483647。其乘积小于 int64 上限；数组键唯一有序，窗口累计与原整数求和一致。失败页不累计，零计数页不占序号。仍取首个覆盖序号的页；该页称号无法映射时先得到 NULL，再退回查询称号，不跳至后页。

缺失/坏 JSON、非数组、非对象页，以及成功页的缺失/null/文本/布尔/小数/负数/超界计数继续使用原 `relationTitleSql`，保留 SQLite 比较、求和、NULL 与错误行为。序号不经过 JavaScript 转换。逐企业引用的 `relationScopeSql` 保持原式。全部投影只存活于本次语句，没有跨请求结果缓存或新持久表。

定向控制使用真实 SQLite、独立 literal ID oracle 和既有资格读取函数：31 个候选用例及 4 个消费端用例，单 worker 共 35 PASS。新消费用例直接执行共用 count 前，调用生产 `prepareCurrentReader` 注册连接级真实 identity UDF；queryKey 使用已生成的非空合成统代。两个遗漏前置条件的历史 setup FAIL 继续保留，未修改原业务断言或 timeout。早期同组 30 个语义控制在基线与优化后均已通过，不能称为性能 RED→GREEN。

父继承证据中的真实 5000ms 请求取消仍是 FAIL；本候选未运行历史副本、首请求/热态性能、公开 HTTP/MCP、异步导出下载及独立工作簿解析。typecheck/build/full 与全新 Spec/Standards 审查亦由父另行安排。本段优化是否解决端到端仍 UNKNOWN，PR358 保持冻结；不以本说明关闭 #356 或 #296。
