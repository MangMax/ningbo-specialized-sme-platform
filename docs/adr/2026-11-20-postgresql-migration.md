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

## 初始化 PostgreSQL 结构

新建开发或测试库时，先用 PostgreSQL 19 创建 UTF-8 数据库。下面的命令用当前连接角色在同一事务中创建 `business`、`runtime_logs` 与运行所需的字典和日志策略。该角色需要创建 schema 和安装 `pg_trgm` 的权限。已有同名运行 schema 时整笔事务回滚。

```sh
PGHOST=/path/to/isolated/socket PGDATABASE=roster PGUSER=fixture \
  PGSQL_BIN=/path/to/postgresql19/bin pnpm db:init
```

测试和部署只使用 PostgreSQL，历史原库由独立备份保存。

## 已有 PostgreSQL 库的数据精简

停止应用及后台任务，在精简前用 `pg_dump -Fc` 保留完整原库并记录 SHA-256。将备份恢复到隔离库，用 [平台归档清单](../../upgrade/pg/2026-11-data-compaction/export-archive-manifest.sh) 逐表核对采集字节和来源坐标。原库备份作为历史原文的离线归档。验证后先在隔离副本执行精简。使用同一组 PostgreSQL 客户端连接环境变量，并显式设置 `PGDATABASE`。

```sh
bash upgrade/pg/2026-11-data-compaction/run.sh
```

- 成功的健康探针和任务轮询不进入日志，失败仍保留。日志每条仅保存一份事件，列表从同一事件投影。
- 三个平台接口在应用库存储已提取的业务字段和查询范围。每个内容版本有一条类型化投影，平台观察保存来源坐标、归属和区别于该版本的字段值。对应关系核对读取这些事实及归属修订。公开查询和记录 ID 随实体保存，原链接继续可用。历史采集原文、完整分页响应和旧存储快照留在离线备份。历史观察补索引和分页来源补录已从应用导入契约退役。
- 候选按需生成。迁移仅清除从未人工裁决的自动候选及专属回执。对应关系保留来源摘要、校验值及人工审计。导入回执保留请求哈希和执行结果。公布名单收件保留来源载荷。
- 平台批量查询的任务记录只保存执行摘要。逐项结果的分页、历史失败及结构化业务记录保存在平台模块，读取和续跑使用同一检查点。单次实时查询可按需返回原文供调用者离线保存。候选发现和年度核对的终态任务每天清理超过七天的记录。
- 差异决定保留历史证据有效性。旧复核回执用于重放、归并及历史资格读取。退役范围证明前确认不存在证明、证明审计或接口与导出对应的确认历史。

迁移成功后通过备份恢复或表重写回收空间。使用同一副本比较资格、导出以及文件原件，保留迁移前备份供恢复演练。

恢复演练比较 `business` 与 `runtime_logs` 的主键顺序二进制内容及序列高水位。恢复目标需预装 `pg_trgm`。

运行日志可在隔离应用设置 `NUXT_POSTGRES_LOG_URL`，连接同一数据库内的 `runtime_logs`，使用独立连接池。容量以每条已存事件 JSON 的 UTF-8 字节数计，排除索引、副本筛选列、数据库物理开销和 stdout。写入、保留清理与策略修改通过固定策略行协调，事务内同时维护容量计数；旧日志的原始 JSON 与模块空值保留。

## PostgreSQL 单库启动与恢复演练

先物化 `business` 和 `runtime_logs`。服务使用 `NUXT_POSTGRES_DIRECTORY_URL` 连接业务库。日志使用独立连接池，可用 `NUXT_POSTGRES_LOG_URL` 指定同库日志角色。设置 `NUXT_DB_READONLY=1` 后，业务读取仍可用，应用停用任务领取和业务写入。

Compose 从 `ROSTER_ENV_FILE` 读取连接配置。隔离环境可用 `postgres-local` profile 启动数据库并从 `ROSTER_POSTGRES_ENV_FILE` 读取初始化凭据，应用使用服务名 `postgres` 连接。容器内的 `pg_dump` 和 `pg_restore` 来自 PostgreSQL 19 官方镜像。

名录工作簿的生成、下载、任务历史和过期清理共用 `NUXT_ROSTER_EXPORT_DIR`。Compose 通过 `ROSTER_EXPORT_DIR` 配置，默认使用持久卷上的 `/state/data/roster.db.exports`。已有部署升级时，将它配置为当前工作簿目录。换目录时，在恢复任务执行前迁移产物文件，并为所有实例配置同一路径。

`NUXT_CURATED_PATH` 提供人工标注，供比对、比对导出与标注接口使用。`NUXT_RECONCILE_PATH` 提供历史核对摘要，供比对查询使用。这两个配置指向 Compose 的持久目录。

冻结隔离源库的业务和日志写入后，使用 PostgreSQL 19 客户端和本机 Unix socket 运行以下演练。源库表的二进制 COPY 校验与 `pg_dump` 使用同一个导出快照，按主键或完整唯一键顺序计算 SHA-256，并比较序列的 `last_value` 和 `is_called`。序列状态不受事务快照保护，演练期间须保持源库冻结。临时恢复库沿用源库编码及 locale，退出时清理该库及归档。文件库原件与应用恢复后的业务请求另行验收。

```sh
PGHOST=/path/to/isolated/socket PGDATABASE=roster PGUSER=fixture \
  PGSQL_BIN=/path/to/postgresql19/bin bash upgrade/pg/2026-11-data-compaction/verify-restore.sh
```
