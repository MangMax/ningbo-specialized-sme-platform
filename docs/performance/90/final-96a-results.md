# #90 最终保留归档工作负载：fresh 96a0bd9

> 历史脚本说明：本文引用的混合表实验/验收脚本已在原生运行切换时退役。复现旧命令须在独立 checkout 固定到 `ab503081dae3e24680afc9b07395a7e3ff21fc9f` 并使用当时的隔离数据库与二进制；这些命令不适用于当前运行库。历史证据与 FAIL/UNKNOWN 保持原样。


本轮授权的 1x 和 query/relation 局部域合成 2x 调查矩阵、完整字段校验及私有恢复演练已完成。建议仍为 **defer 生产 PostgreSQL 迁移**。这里是同算法、同语义、同总资源包络的窄工作负载比较；没有 Node 性能等价、纯引擎排名、容量或生产 SLO 验收结论。

完整聚合见 [final-96a-results.json](final-96a-results.json)；运行步骤见 [retained-workload.md](retained-workload.md)。逐请求记录、原文、数据库、PGDATA、凭据、失败日志及完整遥测均在 Git 外。

## 精确来源与准备

- 测量代码：`96a0bd9c21d6c0ac32f0de45daf44b76bbda99e6`；新隔离工作树 `/Users/mang/.t3/worktrees/app/perf-90-final-96a`。
- 原始只读源 SHA-256：`2c72355ebe602b24d9c0a08561957481d97b083a78aae51995e29e58e4064430`，1,405,333,504 bytes、mode 0400。新运行目录 `/tmp/ningbo-perf-83-90/workload/final-96a-20261020-164417`；旧 `full-1x` 及其 migration/import/oracle 已因 JSON5 修复失效，未作为本轮新证明复用。
- 最终 0025 migration SHA-256：`b12317fa3d39a2891893efccbeffa6a6c1a84c28083ddfbb1136a5e16f0256b0`。
- Node prepare helper SHA-256：`7704756bd3755491dbad0eea99cfd6739c6d9a67bbf304db562548850b678dc9`。`migrate-copy`、`scale2x` 均实际执行 better-sqlite3 13.0.3 / SQLite 3.53.4 / Node v24.18.0；Python 只做只读字段指纹观察。
- 实际适配器/观察器镜像：`sha256:6e41ef436cde2dbe6bac9c625b77edf3f28a2a10994b8eab83a79f1e012fa947`，两后端及观察器使用同一镜像；镜像内 workload.py SHA-256 `8a74dd903ff7d0ce5a0c64d16727b5484a568c45035becf9f407394a10015954` 已与最终源码核对。构建日志、镜像身份和所有源码文件哈希在私有证据目录。
- PG 镜像固定为 `postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a`，实际 PostgreSQL 18.4。全新 PGDATA、新数据库、新 0600 凭据；2x 在同一自有集群中新建独立数据库和 reader。恢复也分别新建数据库，未覆盖任何既有 PGDATA/数据库/凭据。

| 数据集 | query | relation | scope | error |
| --- | ---: | ---: | ---: | ---: |
| 1x | 39303 | 58310 | 21921 | 0 |
| 2x-query-relation-growth | 78606 | 116620 | 43842 | 0 |

1x 的 43 张既有表（含内部表）逐行内容及 CREATE TABLE 定义哈希不变；两个原始归档表的完整字段哈希在 migration 前后相同。2x 对四表的原行集另做逐字段保留核验；clone 的主键、query 外键及 query identity key 重映射，原文和嵌入身份保持原值，其他业务域没有翻倍。两份最终 SQLite 均由实际 Node 验证 integrity=ok、FK violations=0。PG 流式 COPY 后四表所有字段/有序行哈希逐一相同，source SHA 在导入后未变。

每个规模先在最终代码执行真实 listPlatformQueries(summary) / readPlatformQueryEvidence oracle，再验证两后端九例共 18 次 HTTP 读取全部匹配，之后才计时。未忽略 ID、状态、范围、顺序或证据字段。完整分布中的 error 表为零行，因此本矩阵没有新增 malformed/JSON5 反例证明；这些负向/兼容语义继承父任务在最终代码上的回归门槛。

父任务提供的精确集成门槛为 187 文件、2518 passed / 12 skipped、typecheck/build、7 个公开协议/恢复病例及两轴审查。本轮独占窗口没有重跑这些门槛；它们不是本实验的 Node 或 PostgreSQL 公开接口性能证据。

## 方法与全部观测

每个规模九例 × 两后端：每例各 20 次独立 cold-process 请求，hot c1/c2/c5 各 20 次；hot runner 还保留每例一次额外 first，共 1458 个正式计时请求/规模，合计 2916 个。另有计时前 36 次语义读取。cold 轮次/病例交替后端次序，hot 按病例交替；每个 cold 都重启适配器，health 不执行被测查询。没有 OS 缓存清除，PG/OS 页缓存保留；导入和字段校验也会预热缓存。请求 30s、pool 10s 超时及既定预算没有提高。

以下单元格为 SQLite / PG 的经验 p95 ms，每组 n=20。p50/p99/max、返回字节、SQL/读取/序列化分段、墙钟吞吐和失败计数均在聚合 JSON；原样本全部保留在私有目录。20 个样本不足以稳定估计尾部。

### 1x

| 病例 | cold-process | hot c1 | hot c2 | hot c5 |
| --- | ---: | ---: | ---: | ---: |
| summary-page | 31.653 / 41.172 | 16.825 / 19.909 | 65.429 / 68.935 | 405.583 / 394.134 |
| title-filter | 54.187 / 52.848 | 22.629 / 27.202 | 62.032 / 62.408 | 388.963 / 403.885 |
| title-deep-page | 45.568 / 48.797 | 24.070 / 26.610 | 56.901 / 61.674 | 405.480 / 367.462 |
| failed | 44.245 / 78.217 | 15.528 / 17.837 | 69.144 / 69.146 | 484.853 / 495.282 |
| exact-summary | 23.927 / 34.393 | 15.120 / 16.440 | 69.988 / 68.040 | 453.281 / 475.246 |
| empty-key | 45.566 / 31.596 | 17.963 / 16.158 | 71.013 / 69.895 | 483.301 / 478.844 |
| raw-byte-chunk | 33.824 / 48.989 | 17.931 / 32.847 | 99.742 / 80.410 | 516.098 / 411.879 |
| original-collection | 25.277 / 25.702 | 14.662 / 16.158 | 69.643 / 72.092 | 487.078 / 496.943 |
| ordered-relations | 19.059 / 22.112 | 14.737 / 17.435 | 70.475 / 70.364 | 487.035 / 489.152 |

本规模 1458 个计时请求全部 200、语义等于最终 Node oracle，错误/坏状态/语义不匹配均为 0。适配器重启期间另有 **749 次 readiness 探测失败**，逐次类别/退出事件和捕获日志保留；不能将正式读取成功等同可用性验收。
参考线：summary p95≤500ms / p99≤1000ms / response≤256KiB；evidence p95≤750ms / p99≤1500ms。这是与 #82 冻结阈值的实验观察映射，不是 Node 预算验收。
本规模没有上述分位数/响应参考线超标；逐请求超过 p95 参考时长的数量仍保留在 JSON，不将这些样本删除。

### 2x-query-relation-growth

| 病例 | cold-process | hot c1 | hot c2 | hot c5 |
| --- | ---: | ---: | ---: | ---: |
| summary-page | 89.290 / 46.248 | 20.829 / 21.285 | 70.653 / 69.301 | 411.818 / 498.812 |
| title-filter | 142.779 / 61.193 | 30.525 / 36.605 | 60.444 / 55.362 | 401.380 / 365.849 |
| title-deep-page | 62.737 / 47.208 | 33.731 / 33.334 | 49.013 / 66.948 | 423.810 / 366.931 |
| failed | 36.262 / 25.366 | 16.133 / 16.044 | 79.100 / 70.099 | 485.265 / 488.387 |
| exact-summary | 22.332 / 39.320 | 14.439 / 16.009 | 76.001 / 70.477 | 572.742 / 508.249 |
| empty-key | 25.305 / 28.403 | 13.947 / 19.500 | 70.448 / 72.789 | 499.482 / 491.552 |
| raw-byte-chunk | 21.363 / 24.823 | 14.298 / 17.962 | 69.776 / 74.288 | 501.658 / 506.990 |
| original-collection | 28.830 / 34.725 | 15.261 / 16.730 | 76.227 / 71.548 | 507.652 / 501.199 |
| ordered-relations | 26.520 / 36.724 | 15.700 / 17.165 | 75.484 / 76.673 | 472.164 / 404.062 |

本规模 1458 个计时请求全部 200、语义等于最终 Node oracle，错误/坏状态/语义不匹配均为 0。适配器重启期间另有 **758 次 readiness 探测失败**，逐次类别/退出事件和捕获日志保留；不能将正式读取成功等同可用性验收。
参考线：summary p95≤500ms / p99≤1000ms / response≤256KiB；evidence p95≤750ms / p99≤1500ms。这是与 #82 冻结阈值的实验观察映射，不是 Node 预算验收。

本规模全部分位数/响应参考线超标：

- `exact-summary` sqlite hot-c5: p95=572.742ms、p99=586.941ms；p95>500ms。
- `exact-summary` postgres hot-c5: p95=508.249ms、p99=514.823ms；p95>500ms。

1x 集群首次启动还记录了 16 次 pg_isready no-response 后才 accepting connections。2x 复用的是本轮自有集群，不伪称另一轮首次启动成功。冷进程主动 restart 的容器退出码 143 与请求失败分开统计。最终清理时 SQLite/PG app 均为 143，PG 为 0；observer 的 sleep 容器在 1x→2x 切换和最终清理的两次主动 stop 后均收到 SIGKILL、退出 137。两次强制停止均保留在退出事件中，memory.events OOM 计数和 Docker OOM 事件均为零，未当作 OOM 或计时读取失败。全部原样本/失败保留，分位数包含失败耗时；没有挑选样本、增预算或重跑取更优值。

c5 墙钟延迟明显高于 handler 内分段。例如 1x failed/SQLite 最慢样本 549.266ms，而 Read-Ms=0.734042、SQL+materialization=0.421166、Serialize-Ms=0.124583。差额未归因为网络或引擎。观察器、HTTP 调度、IPC、不同缓存/CPU 配额及未分解等待仍是边界；该墙钟差额本身不能用来判定 PostgreSQL 数据库收益。

## 实际资源、物理成本和恢复

Docker inspect 和 cgroup 实际核对：SQLite 1 CPU / 4096MiB；PG app .25 CPU / 512MiB，加 PG DB .75 CPU / 3584MiB，总计 1 CPU / 4GiB。相同观察器独立 1 CPU / 512MiB，预算外单列；内部 bridge 无 host publish，镜像/网络/源文件身份均核对。未将 Darwin node_modules 挂入容器。

计时适配器实际为 Python 3.12.13、SQLite **3.40.1**、psycopg 3.3.6 / pool 3.3.3；准备/oracle 为 Node / SQLite **3.53.4**。SQLite 文件处于 delete journal、只读 immutable、每连接 cache_size=-2000 / mmap=0；PG shared_buffers=128MB、work_mem=4MB，读事务为 REPEATABLE READ READ ONLY、池大小五。相同语义/总 envelope 并不消除 driver、缓存配置、分配和 IPC 差异。

| 规模 | SQLite cgroup peak MiB | PG app peak MiB | PG DB peak MiB | observer peak MiB |
| --- | ---: | ---: | ---: | ---: |
| 1x | 64.29 | 69.38 | 726.25 | 30.92 |
| 2x-query-relation-growth | 68.59 | 70.79 | 1545.45 | 60.59 |

表内为实际读取到的 cgroup peak（含缓存）。1x observer 只保留 cold 阶段 cgroup peak，hot 阶段仅有约 1Hz memory 采样，不能当作完整 hot 峰值；2x 另保留 post-hot cgroup peak。峰值包含各容器生命周期/启动；PG 集群峰值包含导入和此前自有恢复历史，组件峰值不保证同时发生。逐次 memory.current/peak、cpu.stat、io.stat、约 1Hz Docker stats 和终态/OOM/退出元数据保留于私有文件；原始 CPU/IO 为累计观测，不冒充查询净成本。冷进程事件未观测 OOM，终态核验见 cleanup.json；没有 Node heap/event-loop 数据。

| 规模 | SQLite 四表+索引 MiB | PG 四表+索引/TOAST MiB | PG cluster WAL allocated MiB | PG dump MiB | dump / restore s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x | 1198.13 | 511.14 | 496.00 | 31.32 | 7.752 / 20.486 |
| 2x-query-relation-growth | 2401.21 | 1021.48 | 1024.00 | 62.85 | 15.198 / 41.319 |

四表物理成本比较保持相同字段和原文字节；布局、索引和 PG TOAST/压缩不同。SQLite 整个文件还含未迁移域，不能拿整文件与 PG 域体积直接排名。PG WAL 是集群分配量，包含导入/恢复历史，不是每请求 WAL 或写放大。静止 SQLite delete-journal 无持续 WAL，不代表生产 WAL 写负载成本为零。

两个规模均将 pg_dump 恢复到新数据库，并以流式 cursor 核对四表完整字段/行序哈希；均完全一致。SQLite 对静止文件分别备份、恢复，文件 SHA 相同，恢复后 integrity/FK 和四表哈希全部一致。SQLite 备份是全应用文件拷贝，PG 是四表逻辑备份，不能用其时长/大小给备份引擎排名。没有 PITR、RPO/RTO、持续写入恢复或异机恢复验收。PG runtime reader 的非 superuser/createdb/createrole、四表 SELECT=true、INSERT/UPDATE/DELETE/TRUNCATE=false、default_transaction_read_only=on 均已核对。

2x 门槛在执行前核对：宿主可用 42,205,155,328 bytes；Docker 可用 440,884,703,232 bytes；按较小值扣除 12GiB 增长估计后仍保留至少 8GiB。最终磁盘观测及凭据模式见私有 operations.json/cleanup.json。全部失败/旧 artifacts、PGDATA 和输入保留，没有清理他人容器或数据。

## 决策及父任务边界

**defer 生产迁移；本轮窄调查可交父任务评审。** 同资源窄读矩阵和完整归档/恢复字段证明现已具备。PG 的四表物理体积优势是真实观测，2x cold 的 summary/title 样本中 PG 更快（例如 title p95 61.193ms，对照 SQLite 142.779ms），而同例 hot c1 为 PG 36.605ms、SQLite 30.525ms；没有跨模式/病例一致的迁移收益依据。c5 中共同的未分解墙钟差额尤其明显。保留优化后的 SQLite 路线；不据此作普遍 PG 否决，也不把移植整个应用虚设为完成本次调查的前置条件。

仍未执行：实际 Node/正式 PG 应用驱动性能、Node heap/event-loop、其他业务域全量 PG 迁移、混合写/并发首提/行锁死锁、正式 PG REST/MCP 全契约、长期 soak、完整业务 2x/5x、生产/CI/部署、PITR/升级/轮换/值班成本。父任务的公开协议门槛与本轮实验分开，不由本矩阵替代 #81/#91 或生产验收。

私有完整证据根目录：`/tmp/ningbo-perf-83-90/workload/final-96a-20261020-164417`。`comparison.json`、`cold-comparison.json` 和 growth-2x 同名文件保留所有样本；`operations.json`、`storage.json`、`actual-preflight.json`、`images.json`、`all-original-tables.json`、`original-row-retention.json`、执行 harness 及清理/证据清单支撑审计。本轮仅提交文档和脱敏汇总，应用 schema、读取算法和 harness 源码无改动。
