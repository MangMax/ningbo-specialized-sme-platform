# 企业列表与详情读取（#84）

实施候选，不代表 #84 / #81 全部验收通过。冻结预算来自 `/tmp/ningbo-perf-81-89/baseline.md`（#82，原源码 d198a09），不改变 SLO。实现范围仅企业列表、企业导出共用的列表选择器及单企业详情；没有改 schema、索引、迁移、缓存、业务判断、UI 或生产数据。索引/迁移归 #87；首次认定清单、差异清单等其他共享读取入口仍保持原行为，不因本票宣称优化完成。

## 读取方式与兼容性

- 企业列表不读取 `platform_query.raw_response/collection_evidence`、`platform_relation.raw_fields` 或导出 `raw_fields`。生命周期、首次认定、复核、同称号筛选和统计继续调用原判定函数；中文名称排序沿用原 `localeCompare`，没有用 SQLite 的二进制排序替换它。
- 同筛选的统计必须先于分页，且首次认定/差异存在跨记录语义。本候选扫描身份、快照成员关系和轻量历史；历史采用一条有序 SQLite 游标，一次仅组织一家企业的记录/事件/证据。列表只保留排序计数所需的候选字段，选定页后按本页企业 ID 一批补齐完整出处。没有每企业数据库请求。导出继续使用同一选择器的不分页模式。
- 单企业详情先按 ID 读身份，再按企业/记录/事件 ID 批量取记录与证据。查询覆盖为关系归属 ∪ 规范化统代键 ∪ 精确名称键，包含无关系的 failed/no_record/not_queried。已认定查询保留全部源行（含 enterpriseId=null），其他查询保留原有企业归属过滤，差异证据仍保留该查询全部 relationIds。原始 JSON、采集页位置、别名待核状态、差异解释均保留。
- 单企业的快照匹配保留原来的规范化 USCC 优先、名称回退及同名后一个企业优先规则；查询和快照的规范化使用连接内确定性 SQLite 函数调用共享 normalizer，不新增表、持久表达式或业务结果缓存。无关原档不会进入 Node；部分归一化键仍需扫描，SQL 内扫描与驱动返回行数分别报告。
- 查询、关系元数据一次批量读取；关系计数与 queryId 查找改为请求内 Map/Set，消除循环扫描。列表和详情在一次 SQLite 读取事务中完成，无异步跨事务共享状态。
- REST/MCP 参数、默认行形状、读取权限及错误行为未变。MCP 原有筛选能力仍按原契约提供，未增加原先没有的 REST 过滤参数。完整的相关原档不会静默截断；本票没有给任意大单企业原档设置新上限，因此不能据固定企业测试宣称所有相关原档大小均满足详情预算。

## 可复现验证及接缝

`tests/enterprise-read-http.test.ts` 使用真实 SQLite 和真实 h3 HTTP 路由（不是处理器返回值替身）：

- `HTTP list keeps filters, same-title recognition, counts, stable deep pages and confirmed alias search without decoding unrelated archives`：旧版先红（读取无关畸形归档导致 HTTP 500），新实现返回 200；已确认别名、待核别名不参与搜索、同称号首次年份、source+eventType+year 同事件、完整计数与空深页有具体断言。
- `HTTP detail scopes identity and record evidence but preserves recognized unmatched rows, failures, original JSON and source positions`：旧版先红，新实现保留双称号、复核、全部别名、两条原始行（含未匹配主体）、失败查询、页位置及原字段；另断言非法 ID 400、缺失 ID 404。

原有 `tests/roster-enterprises.test.ts` 的生命周期/多称号/差异/名录状态/合并回归及 `tests/roster-enterprise-legacy-api.test.ts` 的历史 Word/Excel 页码行为一并验证。红绿日志在 `/tmp/ningbo-perf-81-89/84/`，不提交数据库、业务响应或日志原文。

`node scripts/verify-enterprise-read.mjs`：起本地生产构建，以合成临时 SQLite 通过真实 REST、MCP tools/list/tools/call 验证；15 组过滤/排序/分页、6 个详情（含同名优先与导出名称回退）与 d198a09 原实现逐字段等价，验证五态、原 JSON、未匹配行、400/404。旧实现仅在小合成库上运行，避免重复已证 OOM。`node scripts/verify-enterprise-read.mjs /absolute/new-synthetic.sqlite --prepare-only` 可建立不含业务数据的 UI 夹具。

`node --max-old-space-size=2048 --expose-gc scripts/bench-enterprise-read.mjs driver /absolute/private-copy.sqlite list 1 5`：模式 list/deep/search/detail。只读打开副本；记录驱动实际物化行/字节、SQL（含原生行物化）、序列化、剩余时间及 heap/RSS。驱动字节为字符串 UTF-8 字节与数字 8 字节，非物理磁盘读取；游标逐行计量有开销，不能拿该计量通道代替未插桩的 HTTP SLO。JSON 解码与业务计算在剩余时间内，未虚构细分。

`node scripts/bench-enterprise-read.mjs http /absolute/private-copy.sqlite list 1`：生产产物、真实 loopback HTTP；传输也可 mcp，热并发 1/2/5。每进程首请求一次（OS 缓存未清空）+20 次热请求，返回 p50/p95/p99、线传字节、采样进程 heap/RSS、OS 最大 RSS 和事件循环延迟。20 样本 p99 是最大观察值，不能建立可靠尾部保证。进程 old-space=2048MiB；本机 Apple M4 10 CPU / 24GiB、Node24.22.0、Darwin arm64，非独占，未施加 1vCPU/4GiB 容器限额。未修改超时或 SLO。

## 基线、数据与证据边界

#82 在完整副本（7297 企业、20473 记录、21700 事件、39303 查询、58310 关系、10021 导出行）上，对企业列表和固定企业详情分别记录 concurrency1/2/5 的 V8 OOM/SIGABRT，发生在 Statement::JS_all 返回响应之前。这是 d198a09 历史基线，来自 #82 的诊断 h3 实际路由模块，不是已完成的编译 Nitro/MCP before 矩阵；旧版 MCP before 未在本票补测，不标成当前 head 测试。原共享快照只有文件读取；本票用私有文件副本、保留 WAL 后私有恢复，绝不修改共享快照。

1x 使用共享快照的新 APFS clone，复制 SHA256 校验保存在 `84/copy-source.sha256`。2x/5x 是另外的私有工作副本追加**合成无关**企业、记录、事件、查询和关系；完整原有事实及固定企业 ID 不变。新增 query raw_response 约 22958B、relation raw_fields 约 4.5KB；不是完整生产分布复制，没有扩容导出/别名，不能称为所有数据表的 2x/5x 等比例验收。数据库及测量输出均只在 `/tmp/ningbo-perf-81-89/84`。

后续记录绑定代码 SHA 与构建/命令输出；文档提交是该源码后继，不能将其他旧构建、前一候选的结果标为最终 exact-head。桌面与390px只在合成库操作，不展示业务资料；浏览器 lane 与性能、REST/MCP lane 分开记录。

## 当前缺口

候选解决了无关大原文全量载入和详情 N+1/重复扫描，但不宣称已满足全部冻结预算：列表仍需轻量全范围计算，长请求会阻塞单 worker 事件循环；插桩测量已观察列表增量 heap 超过64MiB。并发、冷请求及扩容的超预算样本必须保留。真实受控容器、真实生产、全分布5x、任意超大单企业相关原档均未验收；不得将无 OOM、热 p95 通过或 API 等价替代这些缺口。


## 源码与运行凭据（2026-10-19）

本票实现提交 `5706288`（有界原档/流式历史）、`5b181cb`（轻量差异摘要）、`3f57968`（规范 ASCII 统代键不进入 JS 归一化）。下面标记 current 的测量源码为 **3f57968**；`final-*` 文件是前一候选 **5b181cb**，文件名中的 final 不赋予它当前 head 身份。`current-source-head.txt`、`current-source-files.sha256` 保存源码和产物绑定，只有无业务内容的统计进入本报告。

- 3f57968 的 `pnpm test --maxWorkers=2`：140 passed / 2 skipped files；2074 passed / 11 skipped tests（`tests-final.log`）。skipped 未视为通过。
- 同源码 `pnpm typecheck`（`typecheck-current.log`）与 `pnpm build`（`build-current.log`）退出0。构建的已有 worker URL / 第三方注释警告保留，未顺带清理依赖。
- `current-public.log`：真实生产产物 HTTP + MCP，15 组列表输入、6 个详情与 d198a09 小合成库原实现逐字段等价，退出0。
- `current-openapi.log`：本地生产产物的 OpenAPI/Scalar/Swagger 404，health/jobs kinds 200，退出0；不是生产部署验证。
- 3f57968 的合成库真实浏览器端口18488：1280×800 搜索“合成翻页”、下一页到page2（首行026）→抽屉expand27→完整页27→面包屑返回→Escape，q/page/首行保留；390×844 下一页到page3（首行051）→抽屉expand52→完整页52→返回→Escape，q/page/首行保留，scrollWidth=390，25行。首次快速操作撞上搜索防抖期间的旧DOM，等待筛选落定后重跑成功，不把失败尝试算通过。
- 当前浏览器截图保存在本机 browser-artifacts：桌面 `browser-screenshot-127-0-0-1-mvepmzqb-780551b2.png`；390px抽屉 `browser-screenshot-127-0-0-1-mvepngz8-88c11597.png`；390px返回 `browser-screenshot-127-0-0-1-mvepnhrl-0045321c.png`。完整路径及操作记录在 `84/browser-current.md`。前一候选浏览器截图不冒充3f57968证据。

2x 已完整准备为14594企业/40946记录/43400事件/78606查询/116620关系；第一次5x准备因本机可用磁盘降至3.3GiB中止，该不完整库已删除，统计保存在 `scale5-aborted.json`，不作5x证据。清理后改从1x APFS clone 建另一工作副本，成功建立36485企业/102365记录/108500事件/196515查询/291550关系（`grow5-retry.json`）；准备后可用磁盘4.8GiB。均未扩容导出/别名，不夸大分布代表性。

2x 准备库在测完3f57968 driver及5b181cb完整公开矩阵后已移除以释放空间；保留可重建的 scratch grow.mjs 与统计。可从新的只读一致基底副本重跑，不存在修改共享基底后继续称其冻结的情况。1x `exact1.sqlite`、5x `scale5.sqlite` 仍是隔离副本。


## 3f57968 的测量结果

全部数字为本地受控输入的观察值，未删慢样本。公开矩阵每行一次新服务首请求 +20 热请求。1x/5x HTTP/MCP 每个并发均有实际完成的请求；2x 的 current 证据仅 driver，公开矩阵属于前一候选5b181cb，**不冒充3f57968的2x公开协议/性能通过**。5x原档增长是上述合成分布。

|规模/入口/并发|首请求ms|热p50/p95/p99 ms|线传B|峰值heap/RSS MiB|loop p95/max ms|
|---|---:|---:|---:|---:|---:|
|1x/http/list/c1|1450.5|144.1/170.4/183.7|24126|226.0/415.6|1452.3/1452.3|
|1x/http/list/c2|296.0|345.1/698.2/698.8|24126|222.5/401.9|348.1/447.2|
|1x/http/list/c5|382.0|1250.1/2155.2/2155.5|24126|175.0/392.5|1720.7/1720.7|
|1x/http/detail/c1|281.0|57.9/104.4/109.5|74655|110.8/292.4|281.3/281.3|
|1x/http/detail/c2|171.7|94.0/145.5/201.6|74655|116.9/292.6|167.0/167.0|
|1x/http/detail/c5|62.6|212.5/362.2/363.0|74655|106.3/294.5|215.2/215.2|
|1x/mcp/list/c1|407.7|193.9/310.4/317.2|41629|217.6/400.9|408.2/408.2|
|1x/mcp/list/c2|260.7|230.0/407.6/418.2|41629|177.8/407.6|261.8/366.7|
|1x/mcp/list/c5|221.3|484.7/809.7/879.5|41629|182.5/406.8|637.0/640.7|
|1x/mcp/detail/c1|69.4|39.7/45.8/45.8|150897|111.8/293.2|69.0/69.0|
|1x/mcp/detail/c2|76.9|57.8/102.1/102.5|150897|116.3/295.4|97.6/103.9|
|1x/mcp/detail/c5|91.2|143.0/243.0/273.8|150897|117.8/294.4|182.6/198.2|
|5x/http/list/c1|842.8|956.2/2322.3/2494.0|24133|505.8/782.8|1800.4/2321.5|
|5x/http/list/c2|2033.1|2062.5/3536.6/3536.8|24133|500.1/705.9|3537.9/3537.9|
|5x/http/list/c5|1239.8|3377.1/4940.1/5402.9|24133|505.3/822.2|3888.1/3888.1|
|5x/http/detail/c1|603.6|186.7/266.9/311.4|74655|117.1/290.7|603.5/603.5|
|5x/http/detail/c2|225.7|335.0/409.7/423.1|74655|117.4/292.3|225.8/335.8|
|5x/http/detail/c5|178.9|813.3/883.2/1090.6|74655|118.7/294.0|650.6/823.1|
|5x/mcp/list/c1|1281.4|1123.6/1581.7/1646.1|41636|526.7/751.2|1580.2/1648.4|
|5x/mcp/list/c2|1595.4|1188.8/1906.4/3031.9|41636|539.5/831.3|1774.2/1774.2|
|5x/mcp/list/c5|2058.9|7256.8/13863.6/14670.0|41636|447.7/514.2|8833.2/8833.2|
|5x/mcp/detail/c1|838.4|237.2/326.5/436.0|150897|116.2/273.4|834.1/834.1|
|5x/mcp/detail/c2|218.2|254.2/488.4/499.3|150897|119.1/293.9|491.5/499.6|
|5x/mcp/detail/c5|191.4|511.3/988.0/1020.2|150897|115.0/293.9|620.2/697.3|

固定深页(page100,size25)和搜索为同源码 HTTP 并发1，各首请求+20热请求：

- deep：首请求240.9ms；热p50/p95/p99=229.0/291.9/326.2ms；22849B。
- search：首请求202.9ms；热p50/p95/p99=175.9/255.3/267.1ms；1354B。

Driver（native返回行/字节；插桩有开销，各首请求+5热请求，p95/p99均为5个热样本最大值）：

|规模/模式|SQL返回行/B/语句数|响应B|首请求/热p50/p95 ms|最大增量heap MiB|
|---|---:|---:|---:|---:|
|1x/list|41253/6776724/12|24126|1021.3/792.1/958.0|73.714|
|1x/detail|43/68045/12|74655|780.9/156.0/190.9|15.008|
|2x/list|90723/10842386/12|24132|1168.6/882.4/1008.5|93.338|
|2x/detail|43/68045/12|74655|185.2/144.3/170.3|26.524|
|5x/list|239133/23063699/12|24133|1388.4/1094.3/1193.5|157.286|
|5x/detail|43/68045/12|74655|669.5/207.4/251.7|64.055|

固定详情在1x/2x/5x均物化43行、68045B、12条语句、HTTP响应74655B，证明未把增长的无关raw原文载入Node。SQL仍有规范化键扫描；不能把“驱动返回字节有界”称为所有SQL扫描/JS归一化分配都与库规模无关。5x详情首请求增量heap约64.055MiB，高于冻结64MiB，保留为失败样本，不能四舍五入成通过。

列表只扫描轻量列，但驱动物化行和聚合内存仍随轻量历史规模增长；1x/2x/5x最大增量heap均超64MiB。1x HTTP c1热p95低于500ms，c2/c5及5x等有超限；事件循环普遍超100ms/500ms门槛。**#84冻结性能验收未通过**。所有已完成公开样本未OOM，进程heap/RSS低于1.8GiB/3GiB硬界限；这一项不是整票验收。

需继续实施的本票缺口：更少的列表全范围JS聚合/分配（保留同筛选统计和中文稳定排序）、冷请求/并发的阻塞预算、非规范键大规模扫描的内存/时延。不能依赖新增查询结果缓存规避；受控1vCPU/4GiB资源、全分布5x和任意大单企业原档仍未验证。没有给这些未运行lane写pass。


## 集成刷新后的交付接缝

再次合入集成分支的 #87（schema/migrations 仍由该票编写）与 #85 后，运行源码为 **ea52a8766f5a61c2fdf1019bc3bfcfdebbc411d5**，集成tip为8b3a495。`handoff-owned-paths.diff`为0字节：企业读模块、REST/MCP入口、mcp-roster与db/client相对3f57968没有差异。完整1x/5x矩阵仍绑定3f57968，不标成ea52a87重新测过。

- #87合入检查点bbc30eb：全量 `pnpm test --maxWorkers=2` 为141 passed /2 skipped files、2077 passed /11 skipped tests（`tests-integrated.log`），typecheck/build退出0。此后#85合入，没有把这份全量测试升级为新head结果。
- ea52a87：`pnpm test tests/enterprise-read-http.test.ts tests/roster-enterprises.test.ts tests/roster-enterprise-legacy-api.test.ts tests/record-correspondence-bounded.test.ts`，4文件49测试通过（`tests-handoff.log`）。typecheck/build退出0（`typecheck-handoff.log` / `build-handoff.log`）。全仓测试在ea52a87未重跑，父集成最终验收仍需该lane。
- ea52a87生产产物：真实HTTP/MCP的15个列表输入、6个详情旧版等价验证退出0（`public-handoff.log`）；本地生产OpenAPI隐藏验证见`openapi-handoff.log`。这不是部署或生产数据库验收。
- 1x工作副本已由集成现有迁移应用#87索引，非本票自建schema；7297/20473/21700/39303/58310计数未变，quick_check=ok，FK违规0（`integrated-copy-status.json`）。以前矩阵的旧schema不升级成“已应用#87索引”的性能证明。
- ea52a87，合成库、本地端口18492：1280×800真实搜索→下一页page2/首行026→抽屉27→完整页27→面包屑返回→Escape，q/page/25行保留；390×844下一页page3/首行051→抽屉52→完整页52→返回→Escape，q/page/25行保留，scrollWidth=390。等待URL包含搜索参数后才翻页，避开前面尝试的搜索防抖竞态。操作与截图路径在`browser-handoff.md`。

这一head仅补低样本公开探针（一次首请求+5次热请求、并发1），不将5个样本当尾部SLO保证：

|入口/模式|首请求ms|热p50/p95/p99 ms|响应B|loop p95/max ms|
|---|---:|---:|---:|---:|
|http/list|434.1|177.8/239.6/239.6|24126|435.4/435.4|
|http/detail|87.1|38.0/39.7/39.7|74655|84.5/84.5|
|mcp/list|219.1|190.9/207.0/207.0|41629|219.3/219.3|
|mcp/detail|59.8|40.1/49.4/49.4|150897|58.1/58.1|

文档后继提交不改变上述生产源码。交付状态仍为候选，冻结SLO未完整通过；未创建PR、修改main、关闭issue或写生产。
