# SQLite 索引迁移与证据（#87）

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


> 本文为旧混合表模型的历史实测与复现记录。下列脚本/命令使用当时版本；原生运行切换已删除旧 query 夹具脚本。复现实验须固定独立 checkout 到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f`，不得以当前应用打开旧 fixture。
本票仅修改 schema、索引迁移、解释/性能脚本、测试和本文。不改 REST/MCP 契约、读取逻辑、业务唯一键、约束、原文存储、缓存或生产数据。基于 #83 `57cc58ac9a410a4e7f3f973982a9b069bb284832`，开工与交付前合入本地 `t3/implement-spec-81-89`。冻结目标仍是 `/tmp/ningbo-perf-81-89/baseline.md`；本文的实测不是 #81/#91 整体验收。

## 决策与真实计划

迁移 `0013_nappy_dreadnoughts` 仅增加三个非唯一 B-tree：

- `platform_query_status_time_idx(status, queried_at, id)`：覆盖同范围状态计数；status 等值过滤后反向扫描即可得到 `queried_at DESC, id DESC`。
- `platform_query_time_idx(queried_at, id)`：覆盖无筛选的最新/深页 ID 选择。相同时间的 ID 次序仍稳定。
- `platform_relation_uscc_query_idx(uscc_raw, query_id)`：USCC 子查询只从索引发现查询 ID，不扫描含大原文的关系表。

原有所有索引、表定义和唯一约束保留。不引入 ANALYZE、表达式/JSON 索引、触发器或原文外置；这些索引不依赖手工统计才能消除已证扫描。

下面是实际 #83 生成 SQL 的 `EXPLAIN QUERY PLAN`，完整 SQL（绑定值未输出）在私有 `reads.json`，其他路径在 `inventory.json`：

| 请求/SQL | 迁移前 | 迁移后 |
| --- | --- | --- |
| 同范围 status/count，未筛选 | `SCAN platform_query` + `USE TEMP B-TREE FOR GROUP BY` | 覆盖 `platform_query_status_time_idx`，无临时分组 |
| 最新页/深页 ID，`queried_at DESC,id DESC` | 覆盖 identity 索引全扫 + 临时排序 | 覆盖 time 索引反向扫描，无临时排序 |
| status 筛选 ID/计数 | 宽行全扫/临时排序 | `SEARCH ... COVERING INDEX ... (status=?)` |
| USCC 过滤的关系子查询 | `SCAN platform_relation` | `SEARCH ... COVERING INDEX ... (uscc_raw=?)`；外层 query_key OR/id 分支沿用其既有索引 |
| 精确 queryKey / queryId | key 索引 / INTEGER PRIMARY KEY | 保持，key 命中范围内仍可能临时排序 |
| enterprise 关系限定、关系原序 | enterprise 索引 / query_seq 唯一索引 | 保持 |
| 对应/证明审计的所属 ID + id 排序 | audit_edge / audit_proof 覆盖索引 | 保持；完整快照这两张审计表为空，非空保留由迁移夹具验证 |
| import_batch 幂等键 | idempotency 唯一覆盖索引 | 保持 |
| interface 筛选 | identity 前缀查找，随后排序；counts 需读 status | 保持，没有足够收益证据增加第四个索引 |
| titleCode 或 collectionEvidence.titleScope | SQL JSON 条件仍需扫描、相关 json_each | 保留热点；三个索引不能消除 JSON 原文解析，不声称已解决 |

完整分布：39,303 查询，58,310 关系，7,293 种非空关系 USCC、7,292 种非空 enterprise_id（distinct 不计 NULL，不能据此推断身份）。状态为 success 27,545、no_record 11,730、failed 22、partial 6；not_queried 在此快照为 0，由合成协议用例覆盖。接口 apply/business/recognized 分别 8,035/23,941/7,327。低选择性的 status 本身不值得单独建索引；这里的覆盖分组和匹配排序才是收益来源。USCC 平均约 8 条关系/非空不同键，具体键值不会进入报告。

## 存储与冗余审查

原查询表 dbstat 943,968,256B，raw_response 总计 902,336,692B，collection_evidence 总计 13,036,877B；关系表 298,508,288B，raw_fields 总计 265,951,153B（#82 分布）。collectionEvidence 可能重复保留采集页/行与 raw；关系 raw_fields 还保留逐行取证。没有逐行证明可以无损删除这些副本，本票全部保留。大表拆分/外置必须另行 ADR/迁移。

三个新索引分别 1,744,896 / 1,409,024 / 1,740,800B，合计 4,894,720B。数据库从 1,342,353,408 增至 1,347,248,128B，约 +0.365%。v1 完整迁移约 978ms，迁移 WAL 4,939,912B；这是指纹检查后、OS 缓存未清空的构建，不是冷盘上线时长保证。最终脚本还逐条记录 CREATE INDEX 的运行时长，包含提交/同步的总迁移时长另列。

以下属于**左前缀可覆盖的冗余候选**，本票不删除：`ocr_result_file_idx`（file_page_uq）、`stored_file_part_file_idx`（coordinate_uq）、`platform_export_row_batch_idx`（identity_uq）、`platform_export_batch_title_year_idx`（identity_uq）、`enterprise_alias_enterprise_idx`（identity_uq）、`difference_reason_lookup_idx`（version_uq）。窄索引可能有更少页面/更低读成本；删除需要实际读写对照，不能只凭前缀重复下结论。query_key 不是 query identity 索引的左前缀，不能作为冗余删除。保留这些候选意味着其既有写放大仍存在，本票新增写成本仅来自上述三个索引。

## 完整分布 before/after

私有只读来源是 #82 冻结完整快照。脚本只按文件复制来源，绝不对共享快照建立 SQLite 连接；拒绝非空源 WAL、已存在输出目录和仓库内输出。新目录 0700，结果文件 0600，数据库、原始字段与凭据始终留在 Git 外。源文件 SHA256 前后相同；输出保留迁移前/后数据库供读回与备份回滚。SQL 脚本对每张业务表及 sqlite_sequence 逐行按 rowid 计算内容指纹，包含原文、ID、审计与字段值；只输出计数/哈希，不输出原行。

环境：Apple M4、10 CPU、24GiB，Node 24.22.0、SQLite 3.53.4、old-space 2048MiB（V8 总 heap limit 2,348,810,240B）。共享主机有其他进程，未施加 1vCPU/4GiB 容器限制，OS 缓存未清空。完整性/指纹检查会预热缓存，不能把随后的首读称为冷盘。原始证据目录 `/tmp/ningbo-perf-81-89/87/`；v1 私有诊断在 `full-v1/`。

下表 v1 为真实读模型 1 首读 +5 热读，热 p95/p99 在五样本下都等于最大值，仅为观测。SQL 耗时含行物化；JSON/映射残余、序列化时间分别留在 JSON，不把残余当独立纯解析计时。

| 请求 | before 热 p50/p95 ms | after 热 p50/p95 ms | SQL→Node 字节 before=after | JSON响应字节 before=after |
| --- | ---: | ---: | ---: | ---: |
| summary page25 | 45.28/106.38 | 2.72/3.64 | 2864 | 7344 |
| deep page1572 | 68.12/154.42 | 2.32/3.80 | 3073 | 7438 |
| failed status | 121.04/233.45 | 1.45/1.86 | 3597 | 7463 |
| USCC | 352.58/374.73 | 1.87/10.18 | 1080 | 2694 |
| interface | 17.65/21.35 | 19.60/26.11 | 2986 | 7462 |
| title | 141.78/675.12 | 52.70/199.76 | 2986 | 7461 |
| default full page25 | 35.48/36.46 | 4.39/4.78 | 176577 | 191107 |
| exact largest raw query | 1.95/2.11 | 1.85/2.34 | 143963 | 170121 |

所有十组请求（另含企业和精确 key）、全部样本的完整 JSON 哈希相同；status counts、稳定页序、全部关系原序、collectionEvidence、显式 raw、NULL/空集合均由同一输入比较。字节是驱动送入 Node 的字符串 UTF-8/Buffer 字节与数值 8 字节之和，不是物理磁盘读取。迁移只改查找结构，未声称 Node 返回字节减少。v1 读侧采样 heap 最大约 28.84MiB，单次 heap 增量最大约 2.78MiB；指纹/构建/写入全流程 OS 最大 RSS 440.67MiB，不能当成单请求 heap。heap 来自同步 SQL 边界/请求结束采样，不是精确瞬时 V8 峰值。

## 公开 HTTP/MCP 对照（v1）

本地生产构建、相同完整分布 before/after、每格独立新进程；summary 1 首请求 +20 热请求。20 样本的 p99 也只作观测。全部 252 个 summary 请求及 44 个额外筛选/原文/未命中请求均完成；12 种完整结果哈希跨 before/after、HTTP/MCP 全部相等。表中是热 p50/p95/p99：

| 协议/并发 | before 首请求 ms | after 首请求 ms | before 热 ms | after 热 ms |
| --- | ---: | ---: | ---: | ---: |
| HTTP/1 | 12553.2 | 57.2 | 65.7/1258.3/14549.5 | 8.0/63.2/171.7 |
| HTTP/2 | 7479.8 | 94.2 | 133.2/5723.6/5727.5 | 6.3/49.8/73.4 |
| HTTP/5 | 2153.8 | 90.8 | 198.2/43269.8/47896.5 | 26.3/62.2/63.2 |
| MCP/1 | 9172.6 | 71.0 | 81.4/22981.1/23241.6 | 8.7/17.1/26.5 |
| MCP/2 | 20018.6 | 67.3 | 86.7/1714.6/1761.0 | 15.9/31.0/36.5 |
| MCP/5 | 3989.4 | 44.8 | 210.8/1892.5/1937.5 | 18.7/37.6/37.9 |

summary 线传 HTTP 7,344B、MCP 12,373B，前后相同；服务采样最大 heap before/after 85.51/86.17MiB，after RSS 最大 261.12MiB，未 OOM。这里只能判定此分布下 summary 的本轮延迟/响应预算观测通过，不是容器限额或所有筛选通过。

**未通过/仍存在的预算问题**：after 的 interface 单次 HTTP/MCP 为 1251/1573ms，title 为 2953/6816ms。包含这些用例的 c1 服务事件循环最大延迟为 2961/6816ms；HTTP c5 的 summary 专用进程也观测到 2134ms 最大延迟，不能以 p95 较快掩盖 max<500ms 的失败。MCP default full 本次线传 412,943B 超过普通列表 256KiB；REST 同结果 191,107B。保持显式 summary 的兼容选择，不能悄悄删取证字段过关。共享主机干扰可能影响波动，不能据此删除超预算样本。索引消除了上述已证表扫/排序，却没有使整个 #81 场景达到冻结预算。

## 写入、WAL与锁

另建一次性 before/after 完整分布副本，五轮每事务插入 300 个合成查询和 600 条合成关系。raw 25,618B、关系字段约 5,394B，保留 FK ON 与唯一约束；观察到 synchronous=1（NORMAL），沿用驱动/WAL 默认设置，未为提速关闭约束或调生产设置。它不是实际 API 提交/预检吞吐验收。

v1 before 事务耗时 118.19/118.92/79.73/82.66/70.78ms，after 106.60/474.84/150.09/133.39/124.04ms；中位吞吐约 3,629→2,249 查询/秒（另有两倍关系插入），下降约 38%，不能隐去或解释为无代价。共享主机及样本数不足以稳定归因全部差值，所有原样本保留。WAL before 每轮约 11.71–11.73MB、after 11.80–11.83MB，增幅小于 1%。事务前 TRUNCATE checkpoint 只用于统一测量起点；事务内保持默认自动 checkpoint。

独立 Node/SQLite 写入者持有 BEGIN IMMEDIATE，另一连接 busy_timeout=100ms，before/after 分别约 117/119ms 后得到 SQLITE_BUSY；释放写锁后重试均成功。该探针证明索引不消除单写入者规则，不能代表生产锁等待分布。写入后 integrity/FK 均通过，写探针副本随即删除，不污染用于语义对照的 before/after 主副本。

## 迁移、备份和回滚

1. 维护窗口由部署方另行授权。先停止写入者并排空连接；在自有 staging 对一致备份做 integrity/FK/逐表校验，保留原库及 WAL 的完整可恢复备份。不能把本票私有业务快照上传或当成部署脚本输入。
2. 先在备份副本运行迁移与应用读写验证，预留索引、WAL、备份空间；构建 CREATE INDEX 持有写锁，同步启动迁移会阻塞当前进程，不能无维护窗口承诺零停机。
3. 正常应用启动的 Drizzle migrator 按 journal 执行 0013，事务性提交；不要编辑历史 migration hash 或 ledger。只读服务不迁移，需先独立完成迁移再启动。
4. 若构建失败且事务未提交，回滚事务、检查空间/写锁，使用原备份恢复并核对 ledger。若需要完整回退，停止服务后还原一致备份并运行上一版应用，再验证 integrity/FK/ID/audit；不能混用旧主库与新 WAL。
5. 紧急仅撤掉加速结构时，可在自有副本验证后执行下列事务。业务内容不变，但 ledger 仍记录 0013 已应用；重新启用必须显式执行原三个 CREATE INDEX 或恢复迁移前备份后重跑，普通重启不会补回已手工 DROP 的索引。

```sql
BEGIN IMMEDIATE;
DROP INDEX platform_query_status_time_idx;
DROP INDEX platform_query_time_idx;
DROP INDEX platform_relation_uscc_query_idx;
COMMIT;
```

## 可复现与证据映射

```sh
pnpm exec vitest run tests/platform-index-migration.test.ts tests/db.test.ts tests/platform-read.test.ts tests/platform-query-evidence.test.ts tests/platform-query-http.test.ts --maxWorkers=2
node --max-old-space-size=2048 --expose-gc scripts/bench-sqlite-indexes.mjs /absolute/frozen-snapshot.sqlite /absolute/new-private-directory
pnpm build
node scripts/verify-sqlite-index-http.mjs /absolute/new-private-directory
node scripts/verify-platform-query-read.mjs
pnpm typecheck
pnpm exec vitest run --maxWorkers=2
```

- `upgrades an archived SQLite database without changing evidence, IDs, audit or uniqueness and removes proven scan/sort hotspots`：真实旧库迁移、非空审计/原文、相同时间稳定分页、完整关系、约束、重复迁移和 DDL 回滚；先红在原 counts 的宽表扫描，后绿。
- `benchmark refuses an existing output directory before opening or modifying the snapshot`、`benchmark refuses a live WAL source before creating a destination`：拒绝覆盖/活库来源，验证源字节不变。
- `preservation.json`：所有业务/sequence 表逐行哈希、ID、审计、表结构、unique 定义及历史 migration ledger 不变；integrity=ok、FK=0。完整快照空的审计由上述非空合成夹具补足，不假称在生产已有非空数据。
- `reads.json`、`inventory.json`、`writes.json`、`summary.json`：实际 SQL/计划、分布与空间、完整结果哈希、构建/写/WAL/锁；参数和原行均不输出。
- `http-mcp.json`：本地生产构建，REST 和真实 MCP tools/call，对照同输入完整响应哈希；summary 并发 1/2/5，独立新 Node 进程首请求及 20 热请求；其他筛选/原文/分段/未命中各一次。HTTP 线上字节与 MCP 封装字节分别记录，均不发送外部平台请求。既有 `verify-platform-query-read` 补五态、400/401/413、Unicode 分块与脱敏协议回归。

未运行/不作保证：真实生产写入或负载、容器资源受控等价、清空 OS cache 的真冷盘构建/查询、完整业务分布 2x/5x、真实 API 批量写入并发 SLO、桌面/390px（本票无 UI 变更）。#83 的合成 2x 首读 21.1s 是该票历史证据，不能用本票 1x 结果改写为 2x 已通过。JSON title 条件、interface counts 的宽行访问和共享主机尾延迟仍需按冻结目标评估。

## 验证状态与最终 head 证据

v1：相关四文件 23 项通过；迁移/安全三项通过。`pnpm build`、`pnpm typecheck`、既有生产构建 HTTP/MCP verifier、`drizzle-kit generate`（No schema changes）和 diff 检查通过。全仓 `--maxWorkers=2` 首轮退出1：137 文件通过、3 文件失败、2 文件跳过；2,071 项通过、3 项失败、11 项跳过。三个失败全为原有 5 秒超时：platform-export 的 JSON payload、credential-database 的 demo 副本、files-openapi-contract 的字段说明。未改测试或时限，四文件（含迁移回归）单独 `--maxWorkers=1` 复核 23 项全部通过；首轮失败记录仍在 `all-tests.log`。只可称失败已在独立复核中通过，不能把首轮全仓写成全绿，也未证实全部超时根因。

v1 来源为提交前工作树，用于保留原始数值和失败边界；最终提交后的独立重测保留在 `/tmp/ningbo-perf-81-89/87/full-final/`，以 `summary.json.gitHead`、`gitDiffSha256` 和 `http-mcp.json.gitHead` 绑定精确执行 head。执行后的新样本不替换本文 v1 的较慢样本；最终交付同时报告该目录及未运行/失败边界。
