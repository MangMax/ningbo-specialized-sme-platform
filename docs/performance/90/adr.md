# #90 PostgreSQL 调查 ADR（待优化后 SQLite 对照）

状态：**暂缓迁移决策**。调查基于应用 `fc37375eb35ecd175a5746d93dc22129d2a2ffe3`；#81 为母票，#82 只关闭基线调查。此分支只交独立合成 PoC 与决策材料，不修改应用、数据库迁移或依赖。#90 的完整同规模比较尚未完成，不能以本报告关闭 #81/#91 或宣称 PostgreSQL 性能验收。

## 证据边界

| 证据 | 已做 | 不能证明 |
| --- | --- | --- |
| 当前代码/契约 | `db/schema.ts` 有 41 个 SQLite 表，25 个 `.sql` 迁移；`db/client.ts` 用同步 `better-sqlite3`、WAL、`foreign_keys=ON`、Drizzle SQLite 方言；核对了 `POST /api/roster/import/preflight`、`/commit`、回执 GET 与 MCP `preflight_roster_batch`、`save_roster_batch`、`get_roster_import_receipt` | PostgreSQL 应用适配已存在；本 PoC 与正式 API 等价 |
| #82 冻结基线 | 7297 企业、20473 记录、21700 事件/出处、39303 查询、58310 关系、10021 导出行；约 1.34 GB SQLite，一致副本；冻结预算见 `docs/performance/82/budgets.md` | #90 的优化后 SQLite/PG 同规模比较；历史数值不是未来固定正确值 |
| 2026-10-20 现有读基准聚合 | SHA `fc37375e` 的隔离 1CPU/4GiB/Node 2GiB 容器有 OOM 路径与大响应，20 个热样本只作观察 | PostgreSQL 可修复这些路径；生产压测或可靠尾延迟 |
| 本票 PoC | 同一个 Python HTTP/MCP 模拟服务在宿主机 SQLite 和 Docker PostgreSQL 上跑合成事务、重放、读回、备份恢复 | 实际 Nuxt/Node 应用的行为、完整域语义、同资源引擎性能、容量/SLO |

本票私有执行目录为 `/tmp/ningbo-perf-83-90/postgres-poc`。DB、WAL、PGDATA、密码、备份和原始观测仅在该目录。仓库 `scripts/spike-90/` 只含可重用源码，任何脚本都不连接真实业务库。没有访问生产 API、业务凭据、外部平台或原始商业文件。

## 小型公开接缝 PoC

`poc.py` 使用标准库 HTTP 及 `psycopg`；SQLite 为 Python `sqlite3`。模拟表只有 batch/source/relation/audit，**不是生产 schema 的 PostgreSQL 翻译**。REST `POST /api/preflight`、`POST /api/commit`、`GET /api/receipt`、`GET /api/record` 与 MCP JSON-RPC `tools/call` 共用事务代码。模拟请求为约 30 KiB 合成原文和两条不同关系；校验同键预检→提交→REST/MCP 重放、异载荷同键 409、并发重试、原文字节 SHA-256、关系序号、回执和 PoC 自身的追加审计 hash 链。实际应用 `import_receipt` 是持久回执账本；PoC 的 hash 链是试验机制，**不等同应用现有审计实现或其完整 fingerprint 规范**。

三次执行均通过上述语义断言，SQLite/PG 的归一化输出一致。固定池版本 PG `max_size=5`；同进程每请求新 SQLite 连接，不能归因为数据库引擎。首轮无池的 PG 有明显建连开销，故保留但不据此裁决。池版本一次运行的**探索性** HTTP 观测如下；每个 read 30 次、write 12 次，c1 为单并发，另执行了 c2/c5。写入是每次唯一合成键，读为固定键；没有冷 OS 缓存、真实原文分布或生产规模。

| 操作 | 宿主机 SQLite p50/p95 ms | Docker PG p50/p95 ms |
| --- | ---: | ---: |
| 固定键读 c1 | 5.385 / 13.757 | 8.884 / 18.479 |
| 小事务写 c1 | 5.139 / 8.692 | 51.469 / 60.095 |
| 固定键读 c5 | 4.175 / 11.179 | 22.095 / 49.503 |
| 小事务写 c5 | 17.503 / 31.607 | 90.520 / 119.934 |

**这些数字不是“优化后生产应用 SQLite vs PostgreSQL”**：SQLite 在 macOS 宿主机，PostgreSQL 18.4 在 Docker Linux VM；Python 3.12.13 线程服务/`sqlite3`/`psycopg` 与生产 Node 24/`better-sqlite3`/Drizzle 不同；PG 连接池与 SQLite 连接策略也不对称；没有 CPU/内存限额，其他任务并行，第二次最小权限运行的延迟波动显著。没有 SQL/JSON/序列化/网络分段、Node heap、事件循环、真实锁争用、冷热 p99 可靠样本、2x/5x、同硬件资源包络。**不得从表中推断引擎快慢或达成 SLO。** `results*.json` 仅存于私有目录。

本机为 Apple M4/24GiB、arm64、Docker 29.8.2；PostgreSQL 镜像 `postgres:18` 的本地 ID `sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`，实际 PG 18.4；SQLite 3.53.1。Docker 可用，现有应用容器没有改动。PoC 独立容器只映射 `127.0.0.1:55490`，bind mount 到私有 PGDATA；无 cgroup 限额。PG 18 官方镜像的挂载根为 `/var/lib/postgresql`、版本目录为 `/var/lib/postgresql/18/docker`，不可沿用旧版目录假设。[官方镜像说明](https://hub.docker.com/_/postgres)

运维实测：`pg_isready` 曾先报未就绪、随后可连接；owner 初始化 DDL、无建表权限的 `spike90_app` 运行 DML 成功，其 `rolsuper/rolcreatedb/rolcreaterole=false` 且无 DELETE；`pg_dump -Fc` 恢复至独立 `spike90_restore`，当时四表行数分别 `74/74/148/148`，逐表有序字段合并 SHA-256 在源/恢复库相同。容量仅 20 KiB dump，不能代表真实恢复时长。受限 app role 直接执行 `CREATE TABLE IF NOT EXISTS` 报 `InsufficientPrivilege`：迁移必须由独立 owner 步骤执行。池 `max_size=1, timeout=0.3s` 在占满时约 302ms 返回 `PoolTimeout`，释放后恢复。重启 PG 后首次回执读发生 5 次 `RemoteDisconnected`，第 6 次读到 committed 且审计校验有效；PoC 目前未把读端断连映射为稳定 503，正式适配须处理。重启期间的错误不能算作可用性通过。

## 兼容性核对清单

以下为**迁移前必须逐项实证的接缝**，静态定位不等于兼容性通过。

| 接缝 | 当前代码证据与所需验证 | 状态 |
| --- | --- | --- |
| 驱动/异步 | `db/client.ts` 的同步 `better-sqlite3`、按路径缓存、启动迁移和 title seed；多数服务使用同步 `.get/.all/.run` 与 `db.transaction`。需选 PG 驱动与有界 pool、逐调用链 `await`、取消/超时/背压、事务生命周期及错误映射；不能只改 DSN。[Drizzle PG 指南](https://orm.drizzle.team/docs/get-started-postgresql) | 待实现/测试 |
| 方言/迁移 | `db/schema.ts` 全部 `sqliteTable`；`drizzle.config.ts` 为 SQLite；25 个 SQLite SQL 迁移含 `PRAGMA`、建表重建与 `datetime('now')`。PG 应单独 schema/migration 历史，owner 执行、版本及回滚可审；不能把旧 SQL 直接重放。[Drizzle 配置](https://orm.drizzle.team/docs/drizzle-config-file) | 待设计 |
| raw SQL/JSON | `lib/platform/read.ts`、`lib/roster/query-assessment.ts`、`server/utils/import-receipts.ts`、`evidence-impact-113.ts`、`record-comparison-formal.ts` 等使用 `json_extract/json_each`；需逐句改写并核对 JSON 文本/`jsonb` 的 null、对象键序、数值/布尔、数组展开与 fingerprint 输入字节 | 待逐句验收 |
| ID/排序 | SQLite `INTEGER PRIMARY KEY`/rowid 与 PG identity/sequence 不同。`server/utils/roster-import.ts` 同名候选说明依赖 rowid 顺序；迁移后应显式稳定 `ORDER BY id`，导入保留所有原 ID/FK 并将 sequence 对齐。分页同值排序也要验 | 待验证 |
| 唯一/冲突 | `enterprise_uscc_norm_uq`、`record_identity_uq`、`platform_query_identity_uq`、`platform_relation_query_seq_uq`、批次 key、correspondence edge；核对 nullable unique、多列冲突目标、`ON CONFLICT`、并发重试/锁死与 409 映射 | PoC 只覆盖单键，余项待验 |
| 类型/比较 | SQLite text(JSON)、整数布尔、ISO 字符串时间；PG `text/jsonb/timestamptz` 转换须保留原文字节/哈希、UTC/时区/毫秒、未知 null、大小写/排序规则/LIKE 转义、Unicode/企业名归一、`BIGINT` 到 JS number 安全范围 | 待验 |
| 事务/隔离 | SQLite 单写者 WAL 与 PG MVCC/默认 READ COMMITTED 不同；预检虽不写业务行却记 `import_batch`，`import_receipt` 先留 `processing` 再与业务提交同事务，异常留 failed。需在并发 1/2/5、断连/取消/死锁下保留原子性、读后写冲突与回执真相 | PoC 只证模拟事务，正式待验 |
| 状态/证据/审计 | `not_queried`、`failed`、`partial`、`no_record` 不能折叠；`platform_query` 原文和 collection evidence、全部 `platform_relation`、事件出处、文件分段、多关系与正式决定/更正/影响审计不得丢；旧批 `requestBody=not_retained` 不得伪造 | 待全量核验 |
| API/MCP | 同输入响应、字段、错误码、权限/no-store、分页和 `queryCoverage`、版本冲突、幂等回执；REST/MCP 共享域逻辑，工具的鉴权与写提示不能变化。用当前 OpenAPI/MCP 清单跑合成及完整分布 | PoC 仅模拟，正式待验 |
| 算法边界 | 当前已知 OOM/大响应不能靠换库掩盖；投影、谓词、页大小、原文按需读、任务隔离/取消仍需先在优化后 SQLite 验证，再在 PG 同语义对照 | 待集成候选 |

## 运维核对清单

| 项目 | 本票核对 | 进入迁移实施前的验收 |
| --- | --- | --- |
| 持久化/健康 | 私有 bind mount 与 loopback 端口实测；`pg_isready` 启动阶段短暂失败 | 固定镜像 digest、volume/权限、readiness 必须真实查询 DB、资源限额、自动重启及启动顺序 |
| 迁移执行/权限 | owner 建表与受限 DML role 分离实测 | 独立 migration role、app 最小 DML、受控 schema 权限、无应用启动自动 DDL、迁移失败原子回退 |
| 凭据/网络 | 私有 0600 文件；app role 非超级用户；只监听宿主 loopback | secret 注入/轮换、TLS/网络隔离、无日志泄露、服务凭据与业务证据隔离 |
| 备份恢复 | 小型 `pg_dump`/`pg_restore` 与逐表摘要相同；重启后数据持久 | 全规模备份、WAL/PITR/RPO/RTO、异机恢复演练、校验应用可读与原文哈希；`pg_dump` 与物理备份用途不同。[PG 备份文档](https://www.postgresql.org/docs/current/backup.html) |
| 池/断连 | PoolTimeout 与释放恢复实测；重启发生短暂断连且 PoC 暴露错误 | pool 容量/排队/超时、连接泄漏、断连重试边界、幂等写回执恢复、503/健康降级、故障注入 |
| 监控/维护 | 未接真实应用监控 | 连接占用、等待锁/死锁、慢 SQL、WAL/磁盘、checkpoint/autovacuum、备份新鲜度、容量与告警 |
| 升级/成本 | PG 18 镜像目录已核对 | minor/major 升级与回退演练、`pg_upgrade`/扩展兼容、值班与恢复责任、CPU/内存/磁盘/WAL/备份成本 |

## 决策与分期

**当前建议：defer。** #90 的必要最终对照尚缺，且 PoC 是不同运行时/资源环境的小样本；没有证据支持直接迁移生产。满足以下全部条件才建议迁移：优化后 SQLite 在冻结预算和完整分布/混合负载下仍有可归因的数据库瓶颈；PG 在**同一应用语义、同硬件/容器限额、同数据规模与分布**下稳定改善该瓶颈并满足预算；全量数据、REST/MCP、回执/审计、备份恢复及运维成本均验收通过。若这些证据不完整则继续 defer。若优化后 SQLite 已满足预算且 PG 无可解释收益，或 PG 无法保持语义/恢复与运维边界，则 reject **本次迁移方案**，保留后续重新评估可能。阈值/优先端点应在最终测量前冻结，不能根据样本事后调整。

如未来选择迁移，另开 ≤M 的 expand-contract 实施票，按顺序：

1. 冻结变更窗口、源 SHA、公开契约、预算、全量输入清单及回滚点；建立同一仓库独立 PG 方言/驱动/连接池与不影响 SQLite 的兼容接缝。
2. 分域适配读取、写入、任务/文件/OCR/导出和 REST/MCP，逐域公开语义/故障测试通过；迁移 owner 与运行 role 分离。
3. 在隔离库全量导入并核验逐表 ID/FK、原文 SHA-256、事件和出处、全部文件分段/多关系、时间/JSON/null、唯一约束、历史 failed/partial、batch122、全部旧/新回执与 fingerprint；不以总行数代替核验。
4. 生产变更冻结与最终增量封账后单写切换，比较 API/MCP 读回与审计；不默认双写。演练从切换点恢复 SQLite：明确 PG 切换后写入的隔离、导出、人工裁决/重放办法，禁止丢弃或自动双写。
5. 稳定期观察与可回退窗口结束后才移除旧方言/迁移路径，留存恢复证据与审计链。

最终比较的可运行黑盒采样器见 `scripts/spike-90/compare_public.py`；执行门槛与完整覆盖见 [final-comparison.md](final-comparison.md)。它**尚未对优化后 SQLite 集成候选运行**。
