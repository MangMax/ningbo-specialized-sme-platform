# 迁移到 PostgreSQL 19

日期为 2026-11-20。用户已确认全库迁移方向。本决策取代[暂缓 PostgreSQL 迁移](2026-10-20-retain-sqlite.md)中的目标引擎选择。现网切换以同源数据、应用读写、性能与恢复验收为依据。沿用[平台与业务模块边界](2026-11-17-platform-core-and-business-modules.md)定义的模块化单体和事务所有权。

## 目标结构

- 使用一个 PostgreSQL 数据库。业务与运行日志各用独立 schema 和连接池，日志保留策略与业务审计各自维护。文件原件继续由文件库管理，数据库保留原有文件 ID、路径和内容标识。
- 用 Drizzle PostgreSQL 方言和异步连接实现业务命令。跨模块提交共用发起方持有的事务连接。多次查询共享同一读快照的路径使用 `REPEATABLE READ`。任务领取与幂等以行锁、事务和唯一约束实现。
- 迁移保持企业、来源、任务、导入回执和历史证据的 ID 与关系。原始文本和归档字节保留精确值。SQLite 同一字段可存多种类型的源证据，在 PostgreSQL 中保留原始值与类型。只有供业务筛选的结构化数据采用 JSONB、标准日期或原生数值类型。
- 按真实负载验证 `pg_trgm` 的名称包含搜索、信用代码和关联键的 B-tree 索引。保持现有匹配、空值顺序、稳定排序和分页口径。中文搜索用支持 UTF-8 字符分类的数据库 locale。投影和组合索引依据真实执行计划及端到端耗时决定。

## 交付顺序

1. **离线数据转换。** 读取一致 SQLite 副本。用 PostgreSQL 二进制 COPY 逐表导入，按固定行序读回比较哈希。业务与日志分别核验，再执行 PostgreSQL 备份与恢复演练。此阶段的数据 schema 供迁移验收与查询试验使用。
2. **原生运行结构与读写。** 转写主键、外键、检查约束、索引、序列、触发器以及日志保留规则。在同源数据里逐步对照企业基础库、线索名单、文件、名录资格、平台证据、对应与差异、导出和任务。包含失败回滚、重复提交、并发领取、归并和历史字节读回。
3. **性能验收。** 用同一快照、固定资格判定日与同一请求集对比应用时延、并发、内存、返回数据及工作簿。将 SQL 耗时和端到端体验分别记录。
4. **切换。** 排空任务、暂停写入、保存最终一致快照，重跑迁移及回读，随后切换应用连接。恢复演练包括写入恢复前的回切。目标开始接收新写入后，回切必须处理这些提交。

## 离线数据工具

[stage-sqlite.mjs](../../upgrade/postgresql/stage-sqlite.mjs) 使用当前仓库的 better-sqlite3，从只读事务读取源快照。用环境变量 `PGHOST`、`PGDATABASE` 和所需连接选项指定隔离目标，`PGSQL_BIN` 可指定 PostgreSQL 19 的 psql 路径。

```sh
node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA
node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA --verify-only
node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA --resume
```

首次运行创建新 schema。状态、SQLite 序列高水位、文本、NULL 和二进制证据随表导入；SQLite 的优化器统计由 PostgreSQL 重新生成。验收以完整的逐表哈希清单为准。`--resume` 会先核验已存在的表，再补导尚未出现的表。工具生成的是对账数据结构，生产运行结构按第二阶段交付。

## 隔离验收与恢复

用同一份 SQLite 快照启动对照应用。两个实例都设置 `NUXT_DB_READONLY=1`，PostgreSQL 实例另外设置 `NUXT_POSTGRES_DIRECTORY_URL`，使企业列表、资料详情、来源及字典查询走 PostgreSQL。

隔离应用设置 `NUXT_POSTGRES_DIRECTORY_WRITE=1` 后，企业新增、资料编辑、移出、恢复和字典编辑使用 PostgreSQL。设置 `NUXT_POSTGRES_LEAD_REGISTRATION=1` 后，线索名单登记、目录、详情、原件和企业补充使用同一业务库。名单登记与文件维护共用文件行锁。企业补充在一笔事务内保留名单关联、资料审计与名录身份依据。

隔离应用同时设置 `NUXT_POSTGRES_FILE_LIBRARY=1` 后，核心文件 HTTP 列表、上传登记、原件与页图身份核验、显示名和维护历史、软移出、恢复、物理隔离与恢复使用 PostgreSQL 文件身份和维护账本。继续由独立的 `NUXT_FILES_DIR` 和 `NUXT_INCOMING_DIR` 保存原件和上传分片。文件写入口另需 `NUXT_POSTGRES_DIRECTORY_WRITE=1`。保留 SQLite 只读实例供尚未迁移的模块查询。

物理命令先在 `stored_file` 行锁内提交意图，再获取同一个行锁核对内容身份、修订与实时引用，移动原字节并提交维护记录与完成回执。线索登记使用同一行锁，名录按原路径读取引用。新增名录出处的命令也须使用这一行锁。事务失败后，使用原幂等键重试或显式恢复未完成意图。

当前兼容文件列表保留线索引用筛选。名录文件维护、文件 MCP 和 OCR 继续按各模块迁移。可使用 `TEST_FILE_LIBRARY_PG_BIN=/path/to/pgsql/bin pnpm test:app tests/files/storage/library-contract.http.app.test.ts --maxWorkers=1` 对同一合成快照验证 SQLite 和独立 PostgreSQL 实例。

设置 `NUXT_POSTGRES_ROSTER_READ=1` 后，首次认定和台账年份使用名录原生表。设置 `NUXT_POSTGRES_DIRECTORY_URL` 时，工信部平台的申报、关联办理和认定目录列表、详情与筛选读取原生表。申报与办理的精确原值使用带 SQLite 类型的字节列，早期生成的暂存 schema 需要从原始快照重导。

设置 `NUXT_POSTGRES_JOBS=1` 与可写业务连接后，任务中心在应用启动时领取任务，并在关闭连接前等待当前任务退出。线索 CSV 使用任务执行时点的统一读快照读取名单和有效称号。任务领取令牌保护进度和终态，恢复保留已提交进度与检查点。

重建已实现的原生结构时，先生成业务与日志的已对账暂存 schema，再按以下顺序在隔离数据库运行。第一条命令创建 `business` schema，存在同名 schema 时中止。

```sh
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-enterprise-directory.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-enterprise-identity.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-jobs.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-file-and-lead-lists.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-roster.sql
psql -X -w -v staging=staged_logs -f upgrade/postgresql/materialize-runtime-logs.sql
```

恢复演练比较 `business` 与 `runtime_logs` 的主键顺序二进制内容及序列高水位。恢复目标需预装 `pg_trgm`。

运行日志可在隔离应用设置 `NUXT_POSTGRES_LOG_URL`，连接同一数据库内的 `runtime_logs`，使用独立连接池。容量以已存摘要与详情 JSON 的 UTF-8 字节数计，排除索引、副本筛选列、数据库物理开销和 stdout。写入、保留清理与策略修改通过固定策略行协调，事务内同时维护容量计数；旧日志的原始 JSON 与模块空值保留。
