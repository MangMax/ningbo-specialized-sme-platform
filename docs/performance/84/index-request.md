# #84 给 #87 的查询计划实验请求（未采纳 DDL；独立副本探针见后文）

本工作树没有 schema/迁移修改，也没有在测量副本上创建试验索引。以下是独立实验范围，不是已获收益证明的索引合入要求。

1. 列表 `fact_base` 从 `record_identity_uq` 顺序扫描企业×称号记录，通过 `record_event_record_idx(record_id)` 查事件；该索引不覆盖本次需要的 `event_type/year/decided_year/id`，仍回表。`history` 和默认差异计数有临时 GROUP BY，只有存过解释的企业需要窗口排序。原续作源码计划见历史本地 `plan-release.json`，R1 当前计划见 `review-fixes-r1/mask-plan.json`；不能将更早的 `selection-plan*.json` 当本轮计划。
2. 在独立副本试验 `record_event(record_id,event_type,year,decided_year,id)` 的覆盖收益，至少对默认列表、firstStatus、source+eventType+year、浅页/深页及c1/2/5运行同输入对照。证据须包括完整 EXPLAIN、是否免回表、原始返回结果摘要、SQL/总时延、heap/RSS、索引构建时间/体积、300行提交吞吐/WAL/锁等待和恢复步骤。前缀可能覆盖旧 record_id 索引，但不直接删旧索引；由#87核对所有消费者及写代价后决定。单有覆盖计划不算冻结SLO通过。
3. 详情的非规范 USCC 和导出身份匹配仍含表达式，现有 raw-key 索引不能覆盖所有归一化比较。若实测仍需要结构变动，单独设计非唯一的 `enterprise uscc lookup→id desc`、`platform_query normalized key→id`、`platform_export_row normalized USCC/name→batch/id` 查询键列及索引。键值必须由共享 JS normalizer 产生，并保留原始列、Unicode/NUL语义、精确 name: 匹配、同名后一个企业优先和USCC优先/名称回退。先完整 backfill/冲突清单，再覆盖所有应用写入/合并/替换路径及事务回滚；不把冲突键改成唯一键，不擅自归并企业。
4. 不把本轮连接内 `roster84_*` 函数直接写进持久表达式索引：其他写连接不保证注册这些函数，且 JS/ICU 规则版本需要显式管理。不得靠仅当前连接能写的索引污染共享迁移。

这些实验不能单独解除事件循环阻塞；同步计算的执行边界仍由#84负责。也没有证据允许先建整套派生查询结果缓存。本请求不是自动分派、issue修改或生产操作。

## R1 implementation follow-up (no migration)

A disposable **owned** 5x clone tested the proposed event covering index. A narrow
native mask aggregate improved from roughly78–81ms to65–67ms; grouped facts improved
from about88–99ms to77–79ms. These are small local native probes, not HTTP SLO or
write-cost acceptance. The probe index was **not** applied to any 1x/2x/5x matrix
input or schema/migration file. The R1 implementation instead reduces repeated
CTE grouping, uses compact masks only for the known reference dictionary, computes
sparse explanation coordinates separately, and preserves the generic path for
complex filters/unknown titles. It also reuses one worker-owned readonly pager
between completed independent transactions. No evidence currently justifies an
essential DDL exception; original #87 write/WAL/plan qualification remains required
before any such index is adopted.
