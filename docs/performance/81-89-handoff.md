# #81–89 集成交付与验收边界

集成分支 `t3/implement-spec-81-89`，草稿 PR #92。应用执行代码与验证提交为 `6016c056ec71c141c5b590dbdd6a8834bf8d3e8c`；本收尾文档的后继提交不改变执行代码。未部署生产、合并 main 或关闭未完成票据。

## 已交付

- #82：隔离完整分布基线、冻结预算、入口/字段分布与复现脚本。#19 已有按键读取经核实，状态未改变。
- #83：SQL 分页/同范围计数、显式摘要、精确原文及 UTF-8 分块取证；超预算完整响应明确 413，不截断证据。
- #84：轻量 SQL 选择、范围详情、独立只读快照、有界异步子进程及响应背压；保留筛选、统计、生命周期、中文顺序与 UTF-16 搜索语义。
- #85：对应列表/点读/审计/候选的范围读取与批量来源补全，保留指纹、修订、追加审计和关系顺序。
- #86：轻量目录、显式来源对比、标量全局计数、按页出处、proof/asOf、跨 yield 快照与取消释放。
- #87：三个已证收益非唯一索引；完整内容、ID、审计、约束与外键保留。写放大及迁移锁/空间代价见独立报告。
- #88：调查后拆分 #93 文件/OCR/导出、#94 快照入库、#95 MCP 容量；本分支实施 #94 的按输入键规划和 200 行/1MiB 顺序分片，保留原事务/幂等/重试。
- #89：仅公开 REST 无筛选摘要第一页缓存，8MiB/128 条/单条64KiB/TTL5秒/LRU，提交感知；敏感原文、MCP、筛选、凭据及 no-store 绕过。

## 审查与修复

R1 规范轴发现 worker 测试就绪竞态和未用迭代器；规格轴发现 UTF-16 子串回归及同步企业执行阻塞，均已修复。R2/R3 实际复现大原文致命分配、提前断连槽泄漏、对比早断连仍计算；已用独立 OS 子进程、分片编码、终态检查及取消回归处理。

R4 独立复核在候选 `7d9ef86` 默认无观察器启动下，3 个新进程各连续读取 5 次 96MiB 原文，15/15 完整响应及 health/list 通过，未发现新的支持性缺陷。它不代表任意大小或 96MiB MCP 验收。

原先 child old128/semi64 有效总 V8 上限320MiB，调整为 old256/semi16 后实际304MiB，总额下降；应用参数未增大。默认 Node24 在本机的应用 V8 上限约4.19GiB，不能称默认强制2GiB。显式2048旧生代的实际总限制约2.19GiB。V8限制不等于native/RSS或多进程总内存限制；报告另计应用+子进程实测。

## 最终集成验证

在干净 `6016c05` 上顺序执行，全部退出0：

| 命令 | 结果 |
| --- | --- |
| `pnpm test --maxWorkers=2` | 149文件通过/2跳过；2135测试通过/12跳过 |
| `pnpm typecheck`、`pnpm build` | 通过 |
| `node scripts/verify-enterprise-large-repeat.mjs` | default/2048，30/30重复96MiB完整读取，独立原文hash与health/list通过 |
| `node scripts/verify-platform-query-read.mjs` | 真实HTTP/MCP筛选、五态、完整原文/关系/分块及400/401/413通过 |
| `node scripts/verify-platform-cache-safety.mjs` | 两实例提交/回滚、no-store、凭据/数据源隔离及重启通过 |
| `node scripts/verify-enterprise-read.mjs` | 54列表输入/12详情与原实现等价 |
| `node scripts/verify-prod-openapi.mjs --skip-build --port 34992` | 生产构建文档隐藏、业务路由正常 |

日志保留在 Git 外 `/tmp/ningbo-perf-81-89/final-integration/*-6016c05.log`。其他切片矩阵、桌面/390px及审查证据仍绑定各报告记录的实际 SHA；不升级成最终 head 新跑的结果。历史失败没有被单例复跑或新样本覆盖。

## 尚未完成：不关闭、不宣称全规格验收

- #84 补充矩阵 default/5x/HTTP详情一次冷812.347458ms，超过750ms检查；其余热/内存/loop检查通过也不能将这一行改为通过。有限交替对照未隔离原因。尾分位样本仅20次，不是部署保证。
- 完整业务分布2x/5x、受控1vCPU/4GiB、Linux/Node22/native ABI、小时级混合读写/内存/WAL、持续背压/取消与全部恢复窗口未验收。已有扩容按具体表/合成无关数据建立，不冒充全业务分布。
- #93 未实施；#95 的大MCP批次仍在默认4MiB入口返回413，授权HTTP同key恢复不等于MCP容量通过；#88保持开放。
- #82记录4个本机缺失源文件；生产副本对应/proof空表不能代表大规模证明审计验收。
- #90 PostgreSQL 与 #91 最终全规模验收在本次 #81–89 范围外；#81保持开放。生产切换仍需后续用户指令。

因此 PR 保持草稿，所有不满足完整验收条件的票据保持开放。没有通过关闭票据、提高预算或声称代替上述证据。

## 报告入口

基线：`docs/performance/82/`；平台：`docs/platform-query-read-performance.md`；企业：`docs/enterprise-read-performance.md`、`docs/performance/84/continuation.md`；对应：`docs/correspondence-read-performance-85.md`；来源对比：`docs/source-comparison-read-performance-86.md`；索引：`docs/sqlite-index-performance.md`；入库：`docs/snapshot-ingestion-performance.md`；缓存：`docs/query-cache-decision-89.md`。

业务数据库、原档、文件、凭据和私有selector均不在Git。临时证据目录需要独立保留；清理实施worktree不会将其当可删除业务数据。索引备份/停写迁移/回滚按索引报告，缓存可用 `NUXT_PLATFORM_SUMMARY_CACHE=0` 禁用。
