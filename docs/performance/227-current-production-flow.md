# #227 当前生产数据副本的固定读路径 A/B

2026-10-23。范围仅为 benchmark、helper、报告；Parent #225，对比 #226 / PR #229。发现接口的所测首请求与热态延迟下降，成功路径响应保持一致；其他路径有上升样本，原始失败全部保留。**这不是全站、实时生产承压或最终集成树的全面性能验收。**

## 固定对象与数据

| 对象 | SHA / tree |
|---|---|
| 基线 | `932886b4fb2c110708b9e95943a774abfde0a37b` / `66f859ff770b2d39666bae9a83a16a08c1abade2` |
| #226 候选 | `2f76c351bc642f695716ca1f9ba9ab85b92eebb2` / `d3adfed909c56ae5f52251de1867b583d0d44d7c` |
| 备份收据记录的生产代码 | `ecf77f609c5ac92caafd8e480e6a3356dc6b3d5b` |
| 最终运行时代码（仅另作有界正确性确认） | `ff93c68a9197b47acd254b04490128aa1cf040b9` / `30fb946a7e929afd404a8854bf0f6e26638319d0` |

使用父线程已取得的 **2026-10-23T07:37:55.395Z 新 SQLite online backup**，不是旧验收 seed。1,426,837,504B，SHA-256 `02ff045e62e0611f07b8454f5a1fb6ea48c0610fbc3e121976cdb009659a0568`。来源容器、原路径与取得方式保留在 Git 外 `production-snapshot.json`；本代理没有连接生产数据库或容器。

先以 `mode=ro&immutable=1` 检查独立备份，再逐行流式计算全部 45 表的完整列指纹：`integrity_check=ok`，外键违规 0；两次指纹完全一致。企业 7,297，记录 20,473，事件 21,700，查询 39,303，关系 58,310，对应 571，审计 991，任务 31，迁移账本 28 行。结束时原备份及权限只读的基线副本 SHA 仍与收据一致。

基线既有 `.output` 由父线程指定，安全复制后运行；源码关联来自父线程声明，不冒充本代理重新构建。候选另核对 clean HEAD/tree、构建收据、源码 hash、入口 hash，并复制完整产物。两版 server 全文件 manifest hash 分别为 `fa859fbff1faec63a250733e2a4100e77bc288646149ff32b4efc49a98f8026d`、`1cccb29cc9972ca3b6b7e1bd1f92f2eee2d0f3ae7b9a8f057f4f381da2ba09d8`，各自运行后不变。没有重建根目录 `.output`、操作 43932 服务或改变产品规则/UX。

最终运行时代码的有界确认另记于 Git 外 `final-ff93-confirmation/`：独立确认 root clean HEAD/tree；494 个后端、依赖及配置文件的集合、Git blob 与 SHA-256 均与 `2f76c351` 相同。父线程提供该 head 的成功构建及日志，本代理只复制产物；完整 `.output` 文件 manifest hash 为 `fe76ad5cfafe60f2a306f863ba277e477bab8664930d79014a4dde1c28052b04`，复制前后相同，私有副本运行后不变。最终 server manifest `e8861b2ad79c770c0c84d5ff37b0663ea8433c8af00497d6df24c27e44cf25b4` 与候选不同；构建未被称为同一产物，入口 hash 相同也不替代全产物身份。

从已冻结矩阵选取 15 个请求，覆盖发现锚点/零候选/越界页、来源目录、企业/事件、原档、审计、有效对比、两段完整原始响应及任务读取；只串行各请求一次 REST 和适用的 MCP，共 **26 次成功响应，其完整 canonical hash 与业务事实 hash 全部等于 `2f76c351` 原有结果**，原档字节 hash 亦一致。只读请求使用独立 RO 副本，两个任务 GET 各用新 RW 副本；三副本主文件未变、WAL 0B，全部自建服务已停止，原备份 hash 未变。本轮没有计时/百分位采样；父线程同时可在同机独立副本做桌面/390px UX 验证，本代理不操作 43932/43954。此项只证明列明路径的最终编译产物正确性，**下文所有 A/B 性能数字仍属于 `932886b4` 对 `2f76c351`，不改称 `ff93c68a` fresh 性能证据**；原 6 失败和其他路径 p95 上升保留。

## 矩阵、计时与正确性

先冻结 41 个实际请求，另增加 4 个单独冻结的有效对比/原档请求；原 41 个请求逐项比对未变。两版各运行相同 45 个请求 × 并发 1/2/5 = **135 单元**。每单元独立 APFS 副本及编译服务进程，严格逐单元串行；只在单元内并发。

| 路径 | 固定单元标识 / 覆盖 |
|---|---|
| 来源目录 | `catalog-all`、`catalog-query-deep`、`catalog-official`、`catalog-exports` |
| 企业/正式事件 | `enterprises-page/deep`、`enterprise-heavy/light`、`event-heavy/light` |
| 候选发现 | 三称号，认定/复核，归档历史代理重/轻；`discover-deep-candidates/deep-coverage/past-end`；失败、部分、空档；scout 锚点，共 17 请求 |
| 原行 | `original-event-heavy/light`、`original-relation-largest`、`original-export-row`、`original-largest-archive-chunk-0/1` |
| 对应/审计 | `correspondence-page/deep/candidate/confirmed`、`audit-history/deep` |
| 记录对比 | 保留原两项无效时点请求；新增 `comparison-selected-document`、`comparison-with-export-scope` |
| 任务读 | `task-list/detail`；GET 初始化 runner/清理可能写入，所以使用各自一次性 RW 副本；其余主矩阵只读 |

17 个发现请求对应 14 个不同真实事件，年份 2020–2026；其中 3 个有确认曾用名、7 个来自多称号企业。重/轻按实际归档历史代理选取，不能等同于候选数量；API 实测含 0 候选及 9 候选、21 条相关归档的样本。稳定 cell 名 `discover-reported-anchor` 指 scout/#226 profile 对照锚点，**没有原 43932 请求 trace，不能据此声明原用户请求参数完全相同**。

首次仅探测 TCP 监听，不用 HTTP 健康检查预热；记录新进程首个业务请求及监听就绪时间。之后进行一次实际 MCP `tools/call` 正确性校验（有对应工具时）、一次显式 REST 预热，再测 **20 个热 REST 样本**。新进程与后述新连接分开，均不宣称 OS 冷缓存。MCP 是单次线协议一致性/字节观测，没有 MCP 热态容量或分位数结论。

每次保留时长、状态、错误、响应 bytes、规范 JSON SHA 与业务事实 SHA；只排序对象键，保留所有数组顺序。没有删除错误或重试测量。两版每版 3,087 次 HTTP/MCP 尝试：**129 成功单元、2,949 成功尝试；6 失败单元、138 错误尝试**。每版 2,700 热样本中 120 个来自上述失败单元。129 个成功配对单元的完整响应/业务事实 hash 全同，成功 MCP 校验也全同。

## 保留失败及构造修正

`comparison-scoped`、`comparison-largest-archive` 各三个并发共 6 单元：所选正式文件 `issue_date=NULL`，指定 `asOf` 按既有契约排除文件，REST 返回 400 `source_set_missing_or_out_of_scope`；每版完整保留 120 热错误、12 首次/预热错误及 6 MCP 错误。

初版 helper 把 MCP 的文本错误当成 JSON，六次额外表现为解析异常；原样保留。helper 已支持文本错误并保留其应用错误状态。两版 REST 错误完整 hash 也不同：Nitro 错误体含临时端口 URL；根据冻结请求、监听日志与错误处理代码，12 份完整 hash 均精确重建，去掉基础设施 origin 后分别对应相同两项错误。**原完整 hash、失败状态没有被改写或归零。** 主矩阵校验器仍退出 1（18 条标记：两版各六项请求失败，加六项完整错误体差异）。

新增两项有效对比请求明确不指定 `asOf`，以不可变数据库冻结当前状态，并选择实际支持事件的正式来源引用；另分别不选/选择导出范围。它们属于另外 12 个补充单元，校验器退出 0，不替代原失败，也不证明缺日期来源的历史时点覆盖。

## 发现接口观测（ms）

下表是每并发 17 个固定请求各单元的最小–最大范围，不混池计算分位数。20 样本 nearest-rank p99 等于最大值，只描述本次运行。

| 并发 | 基线首请求范围 | 候选首请求范围 | 基线热 p95 范围 | 候选热 p95 范围 |
|---|---:|---:|---:|---:|
| 1 | 3694.24–7888.09 | 286.45–902.41 | 132.20–723.72 | 7.16–24.73 |
| 2 | 3550.82–7113.01 | 315.35–1122.62 | 343.87–1635.90 | 16.12–65.80 |
| 5 | 3601.89–6629.55 | 321.65–1056.62 | 652.94–15060.23 | 37.46–203.82 |

同一 scout 对照锚点的完整分位数：

| 并发 | 基线首次 / p50 / p95 / p99 | 候选首次 / p50 / p95 / p99 |
|---|---:|---:|
| 1 | 7888.09 / 252.45 / 359.51 / 464.50 | 394.76 / 10.06 / 13.84 / 14.58 |
| 2 | 6484.80 / 399.40 / 1635.90 / 2813.77 | 410.35 / 19.27 / 24.71 / 24.92 |
| 5 | 5320.59 / 893.08 / 1223.55 / 1223.76 | 378.28 / 39.62 / 48.96 / 49.27 |

最大基线长尾 `discover-past-end/c5` p95 15,060.23ms、主进程 loop max 12,029.26ms；同阶段 CPU 7,545.43ms，墙钟 21,015.44ms，主机 loadavg 从 4.57 升至 7.02。响应正确、错误 0，保留而不重跑覆盖；调度/I/O/缓存各自贡献 UNKNOWN。首个基线单元还与一次资格 helper 重读备份重叠，已单独标注，不能作为无干扰观测。

不是所有路径均加速。正式目录 c5 热 p95 244.84→339.58ms，导出目录 c5 207.73→243.50ms，任务列表 c5 257.67→290.52ms，企业详情重样本 c2 84.96→116.79ms。全量逐单元聚合保留在 Git 外；共享主机、先 A 后 B，没有隔离/交错复测，不能把每个差值归因于 SQL 改动。

## SQL、新连接与资源

独立 source-driver 通道在两版各以 17 个新进程/只读副本测首次 API、同连接热态、同进程重开连接首次；imports、useDb/open、native+Drizzle setup 分记，EXPLAIN 放在计时外重放。34 进程退出 0、34 副本 hash 不变；17 请求两版及重开连接的完整响应 hash 相同，并与编译基线 HTTP 相同。该通道没有 Nitro，不冒充编译请求耗时。

17 组计划基线累计 51 个 `SCAN platform_query`，候选 0；候选使用 query-key/确认别名/owner-null 关系索引与 query PK 查找。scout 锚点直接 API 新进程 5883.60→76.16ms，重开连接 219.24→14.84ms。SQL 计时包含 native 执行/物化，不与重叠 JSON 计时相加；没有证明所有 examined rows 恒定或未来增长倍数性能。

| 成功单元热 REST 阶段最大观测（B） | 基线 | 候选 |
|---|---:|---:|
| app 采样 heap / RSS | 222897744 / 528924672 | 242763256 / 550486016 |
| native worker 采样 heap / RSS | 53785448 / 176046080 | 58331112 / 179929088 |
| 每单元分量峰值和的最大 heap / RSS | 264673432 / 671662080 | 284389904 / 693911552 |
| app 生命周期 OS RSS 高水位 | 528924672 | 562315264 |

这些不是同一时刻实测合计或不可遗漏的硬峰。app loop 分首次/热阶段 reset，native loop 日志是进程生命周期直方图；SQL 方法、iterator-step、JSON 和 5ms/10ms 采样都有观察者成本。早期原始字段 `combinedRssUpperBound` 用了阶段末 app RSS，报告改以保存的两个分量峰值重新求和；helper 已修正并另测六个 RO/RW 单元，确认合计字段正确、WAL 0B、main hash 未变，不替换 A/B 指标。

候选发现热阶段最大 loop 延迟 165.02ms，全流程热阶段 max 249.17ms、p95 最大 239.99ms，仍有交互风险；没有普通读者延迟探针，不能把 loop 指标当成普通 HTTP/浏览器响应证明。MCP 单次校验阶段不提供完整堆峰结论。

最大成功 REST frame 3,212,757B；MCP 校验 frame 5,280,390B。导出对比虽 page 25，实际计数处理 11,932 正式事件、4 平台关系、6,273 导出行，不满足 ≤100 参与记录的小范围前提。真实字段最大 raw response 104,919B、collection evidence 3,505B、relation raw fields 5,904B、source text 1,171B。最大原档两块完整解码 hash 分别匹配冻结快照字节，无截断。

## 环境、缺失与证据边界

本机 Apple M4、10 CPU、24GiB、macOS，Node24.22.1、SQLite3.53.4；两版实际 native addon SHA 相同。app old-space 2048MiB，native 沿用 256/16MiB，未配置 CPU/cgroup/RSS 配额。每单元 loadavg/free memory、前后 `ps` CPU/RSS、app/原生 worker 的 CPU/heap/RSS/loop 及警告均保存；driver 没有独立堆峰值结论。生产 Docker 的实际 CPU/RSS/Node/存储参数没有在取得收据中提供，本代理未再访问线上读取；不能声称资源等价。任务文件目录为空的隔离目录，未验收生产导出文件可用性/下载。

真实缺失明确保留：小巨人复核；无归档历史代理事件；缺 USCC 的正式认定/复核事件；`not_queried` 查询；rejected/unlinked 对应；候选任务及 queued/running/failed/cancelled 任务。1,475 个真实复核的 review outcome 均为 NULL，不冒充已知通过/失败分区。候选 0 是真实覆盖，不能据此声称无查询历史。多 MiB 合成边界、缺身份/归属冲突等合成分区的性能、任务提交/取消/重试 API 写通道未运行；#226 合成语义/聚焦测试属于继承证据。

[历史预算](82/budgets.md)及[acceptance-v2](82/acceptance-v2.md)仅作为已有参考，不设本轮新 SLO、不把 RAW 误归普通元数据帧，也不把原始失败改成通过。没有运行全仓测试、重建根目录、CI 轮询、浏览器/390px、实时生产压测、容量或增长倍数验收。最终运行时 `ff93c68a` 只完成前述身份及有界 HTTP/hash 确认；未重跑整套性能矩阵，后续不同源码/产物也不能继承为 fresh 性能证据。

## 重放与 helper 验证

所有真实 ID、参数、原始指标、SQL/计划、日志、精确命令与警告在 Git 外 `/tmp/spec210-perf-ux/227-evidence/`；基线交付 `/tmp/spec210-perf-ux/227-baseline.md`。主目录为 `baseline-http-v1`、`candidate-http-v1`、两版 `*-supplement-v1`、两版 `direct-*-v1`。`http-comparison-v1.json` 是保留失败的 FAIL，`supplement-comparison-v1.json` 是语义/样本校验 PASS，不能合并成不加限定的“全通过”。

```sh
PYTHONUTF8=1 uv run scripts/perf227-snapshot.py "$PRIVATE/production-snapshot.json" "$PRIVATE/new-qualification.json"
# 没有本工作树依赖时，用 PERF227_ENTRY 指向已核验私有产物加载 SQLite。
PERF227_ANCHOR_EVENT="$SCOUT_ANCHOR" PERF227_ENTRY="$PRIVATE/output/server/index.mjs" node scripts/perf227-matrix.mjs "$PRIVATE/baseline.db" "$PRIVATE/new-matrix.json"
node scripts/bench-production-flow227.mjs "$PRIVATE/matrix.json" "$PRIVATE/baseline.db" "$PRIVATE/output/server/index.mjs" "$SOURCE_SHA" "$PRIVATE/new-run"
node --experimental-transform-types scripts/bench-discovery-connection227.mjs "$SOURCE_ROOT" "$PRIVATE/new-readonly-clone.db" "$PRIVATE/matrix.json" "$CELL" "$PRIVATE/new-driver-report.json"
node scripts/perf227-compare.mjs "$PRIVATE/baseline-run" "$PRIVATE/candidate-run" "$PRIVATE/new-comparison.json"
```

helper 验证：`compare_accepts_identical_complete_inventory`、`compare_rejects_response_drift`、`compare_rejects_percentile_tamper`、`compare_rejects_shared_missing_cell`、`compare_rejects_missing_hot_sample`、`compare_rejects_duplicate_cell`、`whitelist_rejects_write_before_server_or_clone` 共 7 项通过；原始输出在 `controls/validation.json`。另外 `helper-final-readonly-smoke` 与 `helper-final-task-smoke` 共六单元验证最终元数据修正；语法检查与 diff check 通过。它们不是 CI、产品全仓 suite 或新产品 SHA 的性能验收。
