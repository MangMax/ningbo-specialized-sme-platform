# 平台查询读取（#83）

范围：平台历史读模型及 REST/MCP。基于 #81 / #83 与 d198a09；不改 schema、迁移、业务判断或原始档案。索引归 #87。所有测试库、商业原文和运行日志均在 Git 外。

## 兼容契约

`GET /api/platform/queries` 与 `list_platform_queries` 保持既有参数及默认响应：`rawResponse` 仍需 `includeRawResponse=true`；`collectionEvidence` 和每次查询的全部关系仍默认返回，关系按 `sequenceNo` 原序，保留同键重复行、原始字段及采集页位置。查询按 `queriedAt DESC, id DESC` 稳定排序。USCC 仍匹配查询键或任一关系的 `usccRaw`；企业筛选命中一条关系后仍读回该查询全部关系。称号仍匹配直接称号或原采集 titleScope。所有筛选取交集，`counts` **包括 status 筛选**，与 `total` 完全同范围。

新增可选参数：

- `queryId`：正整数，精确定位一次查询，与其他筛选取交集。`queryKey` 保留全部历史，仍可翻页。
- `view=summary`：明确省略 `collectionEvidence`、`rawResponse`、关系实体。每行 `relationsIncluded:false`、`relations:[]`，`query.relationCount` 是数据库中的完整关系数。空关系数组在此模式下不表示无记录。不能同时请求 `includeRawResponse=true`。
- `view=full`（默认）：原有完整语义。**新增显式资源错误 413**：单查询原档字节预算 4MiB，合计单页 8MiB。预算包括实际将返回的采集结果、显式原文、关系原文字段及每关系 1024 字节元数据余量；不是序列化后的网络包大小。超限在大字段进入 Node 前拒绝，不返回不完整证据。客户端收到 413 后用 summary 发现 ID，再走下述精确分段接口；也可减小 pageSize 解决单页超限。旧参数/字段未静默改义，无需迁移现有正常大小请求。

过滤、计数、稳定分页、关系计数均在 SQLite 完成；先选择本页 ID，之后才计算本页预算和读取本页档案。事务内读取计数、页和关系，避免一个响应跨越不同提交。不会载入未选中查询的 `rawResponse/collectionEvidence` 到 Node，也不会因为 `includeRawResponse=false` 仍把 raw 列取出。

## 精确分段取证

`GET /api/platform/queries/{queryId}/evidence` 与 MCP `get_platform_query_evidence` 同义，只读，不访问外部平台，不需要写 token，`Cache-Control: no-store`。

1. `field=relations&page=1&pageSize=100`：按 `sequenceNo` 分页返回所有 `{id,sequenceNo}`，含完整 `total`。pageSize 上限 200。必须遍历全部页；不按平台 relationKey 去重。
2. `field=rawResponse` / `field=collectionEvidence`：读取该字段原始存储文本的 UTF-8 字节。
3. `field=relation&relationId=...`：读取属于该查询的一条原始持久化关系，JSON 使用 camelCase 列名，包含 `createdAt`、完整 `rawFields`，不带展示派生的 `matchedName/sourcePage/sourceRdjb`。采集位置可从完整 collectionEvidence 的 pages 复原；正常大小请求的原列表继续提供这些展示字段。跨查询关系 ID 返回 404。

分块响应：`{queryId,field,relationId?,encoding:'base64',offset,byteLength,totalBytes,isNull,hasMore,data}`。offset 是 **UTF-8 字节偏移**，从 0 开始；length 默认/上限 65536，最小 1。按实际 byteLength 推进，直到 hasMore=false。先连接所有 base64 解码后的字节，再统一 UTF-8 解码（分块可能切开汉字/emoji），随后按需 JSON.parse。`isNull:true` 与空串明确区分。尾部或尾部之后返回空块及 hasMore=false，不伪称截断内容完整。

非法参数 400；不存在的查询/所属关系 404；默认完整模式预算超限 413。保留 failed、partial、no_record、not_queried、success 原值；读侧不重判，不把失败或未完成解释为无记录。不改变既有公开读取权限或写入鉴权；返回已有归档，不重新还原采集时已脱敏的内容。分块不是跨请求数据库快照：若另一写入者修改同一档案，调用方应重新开始读取；本票不引入跨请求锁或缓存。

## 可复现验证

- `pnpm exec vitest run tests/platform-read.test.ts tests/platform-query-evidence.test.ts tests/platform-query-http.test.ts`
- `pnpm build` 后 `node scripts/verify-platform-query-read.mjs`：临时合成库、本地生产构建、真实 HTTP 与 MCP `tools/list/tools/call`，全筛选/五态/关系/原档/摘要/分块/400/401/413 兼容证据。
- `node --max-old-space-size=2048 scripts/bench-platform-queries.mjs prepare /absolute/scratch/scale1.sqlite 1`；同样以 scale=2 建立第二个空库。禁止指向业务库。
- `node --max-old-space-size=2048 --expose-gc scripts/bench-platform-queries.mjs read /absolute/scratch/scale1.sqlite 1 summary`。模式 `full` 表示默认完整响应，`key` 为指定大档案键，`chunk` 为指定大档案块。SQL 返回字节是驱动实际送进 Node 的字符串 UTF-8 字节/Buffer 长度及数值 8 字节，不是物理磁盘读取字节；SQL 时段含原生行物化，JSON/业务映射和序列化为剩余总时间，不虚构更细分段。
- `node scripts/bench-platform-query-http.mjs /absolute/scratch/scale1.sqlite http summary 1`：本地生产构建、只读合成库；transport 可为 http/mcp，mode 可为 full/summary/key/chunk，并发可为 1/2/5。记录新服务进程首请求与 20 次热请求、p50/p95/p99、线传字节、进程堆/RSS 采样及 OS 最大 RSS、事件循环延迟。默认 2048MiB old-space；V8 报告的总 heap limit 还包含 young generation（本机约 2240MiB）。未修改超时。

合成规模 39,303 查询/58,310 关系及双倍 78,606/116,620。每条有约 11KiB 多字节 HTML，collectionEvidence 在页和行中保留重复原文；每千条有约 704KiB 大 HTML，单键完整响应约 2.17MB。关系数包含每查询一条及部分两条，顺序/重复键另由真实 SQLite 和协议用例证明。并非生产分布复刻；无生产数据或凭据。结果与需求映射见本文件后续实测记录。

## Requirement | Evidence

| Requirement | Evidence |
| --- | --- |
| SQL有界分页、稳定顺序与同范围状态计数；非本页原档不进入JSON解码 | `a fixed page never parses unrelated collection evidence and counts keep the filtered scope`（先红：旧版解析未选中归档失败；后绿）；规模脚本记录SQL实际返回字节 |
| 既有筛选、完整关系原序、partial/failed/no_record区别、原始采集页 | `一个 USCC 的查询各自成行,rdjb=3 的 6 条关系逐条在、按 sequenceNo 排`；`按企业过滤:只返回有关系归到该企业的查询,关系仍逐条在`；生产构建 verifier 的 `all filters/paging and five statuses HTTP=MCP`、`complete default raw/relations/source pages` |
| 显式轻量模式与按ID兼容读取 | `summary identifies omitted evidence explicitly and an exact query ID retains every relation`；`public HTTP summary and exact ID preserve partial state and complete evidence without authorization` |
| 单项/单页资源边界不静默截断，完整原文/分段/每条原始关系可还原 | `byte chunks reassemble exact Unicode raw response and complete collection segments`；`relation IDs page in original sequence and each original relation is independently exact`；`oversized full evidence fails explicitly while summary and byte-exact reads stay available`；`full-read byte budgets accept the exact item boundary and reject an oversized combined page or relation` |
| null、空集合、不存在及参数错误明确；鉴权/脱敏不扩张 | `missing identities, invalid ranges and null evidence remain distinguishable`；`public HTTP rejects unsupported selectors and ranges with typed 400 and missing IDs with 404`；真实MCP verifier 400/401、已有采集脱敏回归用例；新取证仅返回已存档内容 |
| 无schema/UI/生产变更；规模内存、冷/热时延与字节证据 | Git diff；`bench-platform-queries.mjs` 与 `bench-platform-query-http.mjs` 实测记录；桌面/390px未运行（本票未改UI），真实生产/容器限额/5倍分布未运行 |

## 2026-10-19 实测（本地合成库）

来源 d198a09；实现候选 `t3/83-platform-sql`。Node v24.22.0 / V8 13.6.233.17-node.57 / SQLite 3.53.4，Darwin arm64，24GiB RAM、10物理/逻辑核。每个服务进程 old-space=2048MiB，V8总heap limit=2348810240字节；本机并非独占，**未施加容器CPU/RSS限额**。1倍库1,517,576,192字节，2倍3,035,070,464字节。没有改超时。

旧 d198a09 默认固定页在1倍/2倍均发生 V8 heap OOM（退出134）；2倍失败约22.77s，最后GC约1970MiB，OS maximum RSS 1,954,660,352字节，macOS peak memory footprint 2,475,741,512字节（两项定义不同）。原精确键查询原本已用queryKey筛选，未冒称原精确键也全表取原文。

下面每行是独立新服务进程：1次首请求 +20次热请求、并发1；OS缓存未清空。首请求不等于真正磁盘冷缓存。20样本的p99等于最大样本，只作观测，不宣称可靠尾部分布。HTTP/MCP采用本地生产构建、只读合成库，不经过外部平台。

| 规模/入口/模式 | 首请求ms | 热p50/p95/p99 ms | 线传字节 | 采样峰值heap/RSS MiB | OS峰值RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x/http/summary | 5854.7 | 35.4/74.9/83.9 | 6947 | 79.2/231.8 | 260.5 |
| 1x/http/full | 67.1 | 42.9/51.3/75.6 | 605672 | 105.2/287.9 | 288.0 |
| 1x/http/key | 33.2 | 15.7/20.2/20.9 | 2165667 | 124.0/318.2 | 319.8 |
| 1x/http/chunk | 20.8 | 2.2/3.4/4.1 | 87540 | 81.6/245.8 | 264.5 |
| 1x/mcp/summary | 184.7 | 58.4/103.8/4046.3 | 11976 | 84.9/263.3 | 265.3 |
| 1x/mcp/full | 61.4 | 40.5/55.0/71.2 | 631276 | 107.6/309.3 | 309.3 |
| 1x/mcp/key | 41.4 | 22.1/128.5/135.3 | 2167237 | 121.1/332.6 | 339.1 |
| 1x/mcp/chunk | 17.1 | 2.3/5.0/7.2 | 87684 | 86.1/248.9 | 264.2 |
| 2x/http/summary | 21123.5 | 95.2/148.6/1039.4 | 6946 | 80.5/239.5 | 264.3 |
| 2x/http/full | 300.0 | 68.3/75.1/76.9 | 605696 | 100.5/303.0 | 303.0 |
| 2x/http/key | 86.8 | 22.2/51.8/57.4 | 2165667 | 125.7/287.7 | 288.5 |
| 2x/http/chunk | 11.2 | 2.3/4.9/5.6 | 87540 | 80.8/245.5 | 263.3 |
| 2x/mcp/summary | 9608.6 | 84.6/120.2/3756.4 | 11975 | 85.0/241.2 | 263.4 |
| 2x/mcp/full | 186.6 | 72.2/89.0/95.2 | 631300 | 107.8/318.3 | 318.3 |
| 2x/mcp/key | 35.5 | 16.6/21.7/22.6 | 2167237 | 124.8/332.2 | 333.9 |
| 2x/mcp/chunk | 20.1 | 2.4/4.6/7.2 | 87684 | 85.7/249.0 | 263.5 |

驱动补充证据（同一SQLite路径，6样本=1新进程首读+5热读，含SQL计时/Node字节观测开销）：

| 模式 | 1x SQL实际返回字节 | 2x SQL实际返回字节 | 1x/2x采样峰值heap MiB |
| --- | ---: | ---: | ---: |
| full | 593438 | 593437 | 28.0/18.5 |
| summary | 2463 | 2462 | 14.5/14.6 |
| key | 2164787 | 2164787 | 25.2/25.2 |
| chunk | 65544 | 65544 | 14.6/14.6 |

新增无关原档从1.52GB变3.04GB，固定页/键/块送入Node的字节未线性增长；全部336次实际规模HTTP/MCP请求成功，未OOM。OS峰值RSS与同步驱动边界采样共同补足同步操作不能被定时器逐瞬捕获的限制；不把采样heap最大值冒称精确V8瞬时峰值。macOS `fsRead` 返回0，不能据此声称物理读取为0；已记录的是SQL送入Node字节及实际线传字节。SQL字节表的full模式原日志名为legacy，表示优化后的默认完整模式，并非旧实现。

**未通过的预算**：首轮2x HTTP summary首请求21,123.5ms，MCP summary首请求9,608.6ms；1x MCP summary热p99=4,046.3ms、2x热p99=3,756.4ms。事件循环最大阻塞同样达到约21.1s。摘要包约6.9KB（MCP约12KB），满足轻量包目标；默认完整页约606KB，仍超过#82普通列表256KiB目标，必须由调用方显式选择summary。heap/RSS硬预算在本机通过，冷延迟/事件循环预算**不通过**，本票不宣称#81/#91性能验收完成。

查询计划：状态counts为`SCAN platform_query` + `USE TEMP B-TREE FOR GROUP BY`；页ID为`SCAN platform_query USING COVERING INDEX platform_query_identity_uq` + `USE TEMP B-TREE FOR ORDER BY`；精确queryKey使用`platform_query_key_idx`；关系发现使用覆盖索引`platform_relation_query_seq_uq`。计数/排序的索引及代价评估交#87，本票未改共享schema或迁移。CPU/IO未隔离可能影响这些时延，但不能删除超预算样本或以重跑较快结果代替。

验证：`pnpm exec vitest run --maxWorkers=2` 退出0：139 passed /2 skipped文件，2072 passed /11 skipped测试；`pnpm typecheck`、`pnpm build`、`node scripts/verify-platform-query-read.mjs`、`node scripts/verify-prod-openapi.mjs --skip-build --port 34983` 均退出0。首轮默认worker全仓测试有既有comparison-scope-proof-http的dev服务启动超时（1 failed/138 passed/2 skipped），有限worker复跑通过，未改测试或超时，未确认首轮启动失败根因。

原始日志与JSON：`/tmp/ningbo-perf-81-89/83/`，含red/green、before1/2 OOM、SQL计划、驱动字节、16组生产构建服务样本、全仓及构建日志。库/原文/凭据不入Git。未运行：真实生产、真实业务库只读副本、容器受控限额、并发2/5、5倍规模、跨请求档案更新压力、桌面/390px（未改UI）。
