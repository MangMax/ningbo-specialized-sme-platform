# 迁移到 PostgreSQL 19

开发服务、生产服务和后台任务统一使用 PostgreSQL 19。沿用[平台与业务模块边界](2026-11-17-platform-core-and-business-modules.md)定义的模块化单体和事务所有权。

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

[stage-sqlite.mjs](../../upgrade/postgresql/stage-sqlite.mjs) 通过开发依赖 better-sqlite3 从只读事务读取源快照。用环境变量 `PGHOST`、`PGDATABASE` 和所需连接选项指定隔离目标，`PGSQL_BIN` 可指定 PostgreSQL 19 的客户端目录或 psql 可执行文件路径。

```sh
node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA
node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA --verify-only
node upgrade/postgresql/stage-sqlite.mjs OFFLINE_SQLITE_SNAPSHOT STAGING_SCHEMA --resume
```

首次运行创建新 schema。状态、SQLite 序列高水位、文本、NULL 和二进制证据随表导入；SQLite 的优化器统计由 PostgreSQL 重新生成。验收以完整的逐表哈希清单为准。`--resume` 会先核验已存在的表，再补导尚未出现的表。工具生成的是对账数据结构，生产运行结构按第二阶段交付。

## 初始化 PostgreSQL 结构

重建数据库时，先生成业务与日志的已对账暂存 schema，再按以下顺序在隔离数据库运行。第一条命令创建 `business` schema，存在同名 schema 时中止。

```sh
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-enterprise-directory.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-enterprise-identity.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-jobs.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-file-and-lead-lists.sql
psql -X -w -v staging=staged_business -f upgrade/postgresql/materialize-roster.sql
psql -X -w -v staging=staged_logs -f upgrade/postgresql/materialize-runtime-logs.sql
```

早期隔离副本若已物化 `business.job` 但缺少任务运行字段，可单独执行 [install-job-runtime.sql](../../upgrade/postgresql/install-job-runtime.sql)。

升级已有 PostgreSQL 库时，先在目标库执行 [install-official-evidence-raw-text.sql](../../upgrade/postgresql/install-official-evidence-raw-text.sql)，再启动新版服务。脚本可重跑，保留已有出处原值。新版服务用三个可空 JSON 字符串列保存含 U+0000 的公布名称、信用代码和属地原值，普通数据沿用原有列。用早期转换脚本建立的 SQLite 暂存 schema 需要从同一源快照重新生成，以包含这三个原值的可逆表示。

恢复演练比较 `business` 与 `runtime_logs` 的主键顺序二进制内容及序列高水位。恢复目标需预装 `pg_trgm`。

运行日志可在隔离应用设置 `NUXT_POSTGRES_LOG_URL`，连接同一数据库内的 `runtime_logs`，使用独立连接池。容量以已存摘要与详情 JSON 的 UTF-8 字节数计，排除索引、副本筛选列、数据库物理开销和 stdout。写入、保留清理与策略修改通过固定策略行协调，事务内同时维护容量计数；旧日志的原始 JSON 与模块空值保留。

## PostgreSQL 单库启动与恢复演练

先物化 `business` 和 `runtime_logs`。服务使用 `NUXT_POSTGRES_DIRECTORY_URL` 连接业务库。日志使用独立连接池，可用 `NUXT_POSTGRES_LOG_URL` 指定同库日志角色。设置 `NUXT_DB_READONLY=1` 后，业务读取仍可用，应用停用任务领取和业务写入。

Compose 从 `ROSTER_ENV_FILE` 读取连接配置。隔离环境可用 `postgres-local` profile 启动数据库并从 `ROSTER_POSTGRES_ENV_FILE` 读取初始化凭据，应用使用服务名 `postgres` 连接。容器内的 `pg_dump` 和 `pg_restore` 来自 PostgreSQL 19 官方镜像。

名录工作簿的生成、下载、任务历史和过期清理共用 `NUXT_ROSTER_EXPORT_DIR`。Compose 通过 `ROSTER_EXPORT_DIR` 配置，默认使用持久卷上的 `/state/data/roster.db.exports`。已有部署升级时，将它配置为当前工作簿目录。换目录时，在恢复任务执行前迁移产物文件，并为所有实例配置同一路径。

冻结隔离源库的业务和日志写入后，使用 PostgreSQL 19 客户端和本机 Unix socket 运行以下演练。源库表的二进制 COPY 校验与 `pg_dump` 使用同一个导出快照，按主键或完整唯一键顺序计算 SHA-256，并比较序列的 `last_value` 和 `is_called`。序列状态不受事务快照保护，演练期间须保持源库冻结。临时恢复库沿用源库编码及 locale，退出时清理该库及归档。文件库原件与应用恢复后的业务请求另行验收。

```sh
PGHOST=/path/to/isolated/socket PGDATABASE=roster PGUSER=fixture \
  PGSQL_BIN=/path/to/postgresql19/bin bash upgrade/postgresql/rehearse-restore.sh
```
