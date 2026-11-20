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

隔离应用同时设置 `NUXT_POSTGRES_FILE_LIBRARY=1` 后，核心文件 HTTP 列表、上传登记、原件与页图身份核验、显示名和维护历史、软移出、恢复、物理隔离与恢复使用 PostgreSQL 文件身份和维护账本。继续由独立的 `NUXT_FILES_DIR` 和 `NUXT_INCOMING_DIR` 保存原件和上传分片。文件写入口另需 `NUXT_POSTGRES_DIRECTORY_WRITE=1`。同一份 SQLite 快照可启动只读实例用于结果对照。

物理命令先在 `stored_file` 行锁内提交意图，再获取同一个行锁核对内容身份、修订与实时引用，移动原字节并提交维护记录与完成回执。线索登记使用同一行锁，名录按原路径读取引用。新增名录出处的命令也须使用这一行锁。事务失败后，使用原幂等键重试或显式恢复未完成意图。

名录文件列表读取分类、文件分段、有效登记和引用，兼容文件列表支持相同业务筛选。HTTP 与 MCP 共用文件列表、分类编辑、维护、页图读取与隔离恢复。上传登记、分类编辑、文件解析和 OCR 结果写入共用文件行锁。文件解析提交核对原件和实际使用的 OCR 页版本，在同一事务内提交段、声明、状态和回执。OCR 历史结果保留原页 ID、版本、原文和采集状态，在线 OCR 使用同一 PostgreSQL 任务连接记录远端回执、恢复认领和页版本，并在同一事务发布页结果和完成回执。恢复复用已采集结果。可使用 `TEST_FILE_LIBRARY_PG_BIN=/path/to/pgsql/bin pnpm test:app tests/files/storage/library-contract.http.app.test.ts --maxWorkers=1` 对照 SQLite 和独立 PostgreSQL 实例。

设置 `NUXT_POSTGRES_ROSTER_READ=1` 后，历年企业列表、企业总表工作簿、企业与称号台账查询、首次认定和台账年份使用名录原生表。企业资料与曾用名维护保留版本、历史和名录身份依据。正式事件与出处的精确读取、事件与出处更正及审计、导入回执及其历史投影使用 PostgreSQL 读快照。主体事实与称号周期处置的预检、提交、历史与重放使用同一套规则，并在事务内核对版本与来源。设置 `NUXT_POSTGRES_DIRECTORY_URL` 时，工信部平台的申报、关联办理和认定目录列表、详情、筛选、完整查询历史、原始凭证和导出快照比较读取原生表。完整查询历史在同一读快照内分页并读取原始证据，保留单查询和整页预算。申报与办理的精确原值使用带 SQLite 类型的字节列，早期生成的暂存 schema 需要从原始快照重导。

当前有效名录 HTTP 与 MCP 沿用独立读进程和有界队列。在 PostgreSQL 读快照内完成候选扫描、见证筛选、分页计数和当前页的三称号资格评估。当前名录导出在单一快照内扫描、分组并生成工作簿。任务中心记录进度和下载凭证。记录级对应的读取、候选发现与决定、记录级比较及来源目录使用原生表。年度过程按原始来源代次读取，年度对应在同一事务记录决定与任务检查点。归档候选任务逐行保存候选与检查点，按归档查询触发后续年度核对。对应与比较范围证明在提交事务内核对来源指纹、版本、审计和幂等回执。

单独导入工信部导出快照时，按称号协调提交，批次、原行、差异证据版本及回执在同一事务内完成。公布名单原行登记、已核对主体补充与出处入库在 PostgreSQL 运行。补充预检回滚临时写入，提交原子保存企业和名录来源。移出仅更新录入状态。差异决定、迁入资格确认、证据影响投影与人工复核写入同一业务库。

单独提交新的工信部采集归档时，申报、办理和认定原件、行位置、业务投影、来源证据版本和回执写入 PostgreSQL。旧采集坐标拒绝替换原值。历史分页补录单独保存原始分页凭证，保留旧归档的覆盖状态。别名导入按原始关系核对企业与名称。同一批次可以合并平台采集、公告登记、正式出处更正、差异判断与企业归并，按依赖顺序提交并保留原子回执。

企业详情的正式证据、业务时间线、差异解释和平台归档共用一个 PostgreSQL 读快照。公布企业业务采集提交前，在同一快照冻结范围并导出、读取校验业务备份。运行环境需提供匹配主版本的 `pg_dump` 和 `pg_restore`，可通过 `NUXT_POSTGRES_BIN` 指定目录。采集原件入库与任务检查点在同一事务提交。

设置 `NUXT_POSTGRES_JOBS=1` 与可写业务连接后，任务中心在应用启动时领取任务，并在关闭连接前等待当前任务退出。线索 CSV 使用任务执行时点的统一读快照读取名单和有效称号，按批读取资格输入。批量 PDF 转图在任务入队时保存文件身份，执行前后复核原件与页图清单。任务领取令牌保护进度和终态，恢复保留已提交进度与检查点。

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

## PostgreSQL 单库启动与恢复演练

先依照前述顺序离线物化 `business` 和 `runtime_logs`。设置 `NUXT_DB_MODE=postgresql` 与 `NUXT_POSTGRES_DIRECTORY_URL` 后，应用启用已迁移的 PostgreSQL 业务入口。日志使用独立连接池，默认复用业务连接 URL。可通过 `NUXT_POSTGRES_LOG_URL` 设置日志角色，主机（或 Unix socket）、端口和数据库须与业务连接一致。默认启动任务执行。设置 `NUXT_DB_READONLY=1` 时，业务池默认使用只读事务，任务列表与详情仍读取 PostgreSQL，提交、取消和重试关闭。仍依赖 SQLite 的入口在连接边界返回 HTTP 503，错误码为 `postgresql_migration_required`。健康检查读取称号和记录数，并检查原生任务表字段和日志策略可读。

容器固定使用官方 `postgres:19.0-bookworm` 镜像摘要提供 `pg_dump` 和 `pg_restore`。Compose 默认让应用连接 `ROSTER_ENV_FILE` 内配置的 PostgreSQL。隔离环境可启用 `postgres-local` profile，先启动 `postgres`，再物化 schema 并启动 `app`。在独立的 `ROSTER_POSTGRES_ENV_FILE` 设置数据库初始化凭据，应用连接地址使用 Compose 服务名 `postgres`。旧版对照 Compose 设置 `ROSTER_DB_MODE=sqlite`。直接启动时，`NUXT_DB_MODE` 未设置则沿用 SQLite，数据库路径默认 `data/roster.db`。

冻结隔离源库的业务和日志写入后，使用 PostgreSQL 19 客户端和本机 Unix socket 运行以下演练。源库表的二进制 COPY 校验与 `pg_dump` 使用同一个导出快照，按主键或完整唯一键顺序计算 SHA-256，并比较序列的 `last_value` 和 `is_called`。序列状态不受事务快照保护，演练期间须保持源库冻结。临时恢复库沿用源库编码及 locale，退出时清理该库及归档。文件库原件与应用恢复后的业务请求另行验收。

```sh
PGHOST=/path/to/isolated/socket PGDATABASE=roster PGUSER=fixture \
  PGSQL_BIN=/path/to/postgresql19/bin bash upgrade/postgresql/rehearse-restore.sh
```
