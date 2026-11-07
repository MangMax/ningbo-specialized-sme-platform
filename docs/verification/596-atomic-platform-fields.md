# #596 后端候选验证

基线：c14ccb339c19b606b70c14c52a4d01fb859802ac；工作分支 t3/implement-596-atomic-platform-fields。开始前 HEAD 等于基线，祖先检查通过；交付前 fetch/merge integration tip，Already up to date。

公开接缝使用真实 SQLite 临时库和 HTTP 预检/提交，三来源独立查询 HTTP 套件；没有生产数据库、文件或部署写入。以下均为本轮新鲜运行。

| 要求 | 用例 / 证据 |
| --- | --- |
| 三来源混合、跨接口同编号、字段字面期望 | `completes a mixed batch with the same platform key kept separate across all three interfaces` |
| 旧版本缺投影修复、共享版本去重、written=0 | `certifies unique eligible versions after shared observations and repairs missing projections on full replay` |
| 收尾缺失回滚、失败回执 | `rejects a projection deleted after its writer before reporting completion and retains the failed receipt` |
| 不覆写不可变字段、整批回滚 | `rejects immutable projection field conflicts and rolls back the other rows` |
| 隔离与显式引用 | `reports quarantines and explicit references without claiming full readiness or repairing references` |
| 旧幂等回执不产生 fresh 证明 | `does not invent fresh completion evidence on an old committed receipt` |
| 新内容版本、源原值/空值/类型、原 ID/hash、补齐命令 | platform-apply/business/recognized-projection-http 与 platform-typed-archive-http 既有回归 |
| 三张独立查询 API/筛选/版本详情 | platform-declarations-http、platform-business-processes-http、platform-recognized-directory-http 既有回归 |
| 同坐标异载荷、预检后漂移、事务重核、并发冲突、引用/audit 不变 | platform-source-replay-http 与 import-writer-contention 既有回归（HTTP/MCP） |
| MCP 提交、来源补齐与发现契约保持 | import-mcp-submission、roster-import-discovery-http、platform-business-projection-mcp、platform-recognized-projection-mcp |

运行方式：`pnpm exec vitest run --root /Users/mang/.t3/worktrees/app/t3-e1a1c8bb <上述测试文件> --maxWorkers=1`。

- 13 文件 / 254 项通过（旧回执新用例添加前）。
- 添加旧回执用例与发现说明后：platform-apply-projection-http、roster-import-discovery-http、import-mcp-submission：3 文件 / 23 项通过。
- 最终去重统计修改后：platform-apply-projection-http、platform-recognized-projection-http：2 文件 / 25 项通过。
- `pnpm exec nuxt typecheck` 退出 0。
- `git diff --check` 通过。

历史红灯：最初两个新用例分别发现缺少完成证明、收尾缺投影仍 committed；后续修复通过。测试构造的投影归属冲突被 SQLite 复合外键直接拒绝，改用真实可构造的字段冲突测试；目录维护批次按现有 string 契约修正独立期望为 `'2'`。

UNRUN：全仓测试、生产/部署、真实厂商采集、桌面/390px 页面、#597 UI 和 #598 最终集成验收、独立审查。原档保留遵循既有事务外文件生命周期，本候选没有写入生产文件或重做历史修复。
