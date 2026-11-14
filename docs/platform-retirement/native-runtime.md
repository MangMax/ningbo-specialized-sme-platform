# 原生运行边界



应用只打开已完成退役的 71613 数据库。空库由 `pnpm db:init [数据库路径]`（调用 `initializeDb({ create: true })`）建立原生 schema；旧库须先在停写的一致副本上运行 `upgrade/run-complete-platform.mjs`。应用启动不执行历史升级，也不根据环境变量选择旧读模型。

`db/schema.ts` 是运行表定义的唯一来源。平台读写直接使用 collection、observation、assignment、三来源 projection 和不可变 archive。对外 queryId/relationId 通过 alias 映射；历史字段值、来源原字节、回执和资格规则版本继续保留，它们不构成旧表读取路径。

旧表定义、阶段 writer/reader 和独立旧 oracle 位于 `upgrade/`，仅供离线迁移与历史阶段测试。运行模块不得通过值导入依赖该目录。`scripts/verify-native-platform-boundary.mjs` 从 HTTP、MCP、插件、任务、worker 和页面入口检查本地依赖图，拒绝离线代码、退役表 SQL/声明及已删除的模型选择开关。它是静态边界检查，不能代替数据库、公共接口和 worker 回归。

六张 body 分块表及其 store/SQL 包装已退役。原生原档仍通过受 owner、seal、长度和 hash 约束的 archive 读取；不保留第二套正文读取实现。

新导入的 `relations[].sequenceNo` 必须是正安全整数，完整新采集须按输入顺序从 1 连续编号；显式 `year` 须是整数或 null。预检与提交均拒绝小数、越界序号及新采集缺号，不再静默截断。原始 `rawFields` 的值类型、已归档的历史字节和引用回放保持各自原值。

旧演示脚本 `scripts/seed-platform-evidence-demo.mjs` 已退役：它直接写混合表，不能生成当前应用可打开的库。历史样例保留在 `ab503081dae3e24680afc9b07395a7e3ff21fc9f`。当前演示使用原生空库，再通过统一导入预检/提交写入平台证据；历史库使用上述离线升级入口，不运行旧 seed 后直接启动当前应用。
