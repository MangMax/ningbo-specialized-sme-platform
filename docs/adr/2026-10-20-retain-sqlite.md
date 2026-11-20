# 保留 SQLite，暂缓 PostgreSQL 迁移

日期：2026-10-20。状态：暂缓迁移。

> 历史决策。2026-11-20 确认[迁移到 PostgreSQL 19](2026-11-20-postgresql-migration.md)。以下保留上一次评估和当时的结论。

关联：[调查 #90](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/90)、[父任务 #81](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/81)。

窄工作负载对照未显示 PostgreSQL 在不同模式和病例下具有一致的迁移收益。应用继续使用 SQLite；合成 PoC 不作为实际 Nuxt/Node 应用的性能、容量或生产验收结论。

将来若重启迁移，应在 Issue 中提出具体瓶颈及收益依据，并验证实际应用驱动、事务语义、并发写入和备份恢复。实验步骤、测量结果和验收记录由 Issue 追踪。
