# #82 调查报告（基线，不是部署验收）

调查对象为 `d198a09` 的现有实现；没有生产改动。范围与SLO在测量前冻结于共享 `baseline.md`，仓库副本见 [budgets.md](budgets.md)。本轮使用 implement-spec、scope-gate、using-git-worktrees、tdd、Nitro 和 verification-before-completion 技能；用户限定本代理只做 #82 且不委派，故不执行技能中的多代理/PR/关闭票步骤。没有新增产品行为或回归测试，TDD 的公开 HTTP/MCP 接缝沿用 #81 已明确授权范围；诊断脚本的内部阶段计时是补充证据，不替代公开接缝验收。

## 数据、环境与可信范围

安全捕获的最终数据副本：7297 企业、20473 记录、21700 事件及21700出处、39303 查询、58310 关系、10021导出行。DB 1,342,353,408B（约1280MiB），25表、49索引、35外键；13条迁移记录，integrity_check=ok、foreign_key_check零违例。最终复制源另有约36MiB WAL；最终基准库是恢复后的SQLite backup，WAL为0。源主库/WAL只读文件采集、全文件hash一致，私有恢复后才连接SQLite；没有生产SQL、生产HTTP或源端SHM/checkpoint操作。已有186MiB归档前备份不够完整，因此没有用它代表最终数据。精确源路径、源文件状态和哈希仅保留在私有 provenance。

完整字段分布见 [distribution.json](distribution.json)，不是“总行数近似”：

| 大字段 | 非空行 | UTF-8字节总数 | p50 / p95 / p99 / max 字节 |
| --- | ---: | ---: | --- |
| platform_query.raw_response | 31810 | 902336692 | 25618 / 62490 / 80254 / 104919 |
| platform_query.collection_evidence | 7327 | 13036877 | 1539 / 2287 / 2962 / 3505 |
| platform_relation.raw_fields | 57993 | 265951153 | 5394 / 5456 / 5561 / 5904 |
| ocr_result.markdown | 408 | 3199933 | 8538 / 13599 / 13667 / 13710 |
| ocr_result.raw | 408 | 5238194 | 13513 / 20359 / 20492 / 20593 |
| import_batch.item_results | 783 | 5498930 | 5815 / 6183 / 90415 / 254350 |

生产副本中的对应关系、对应审计、proof/proof审计均为0，不能用这些空表验证 #85/#86 的长历史、修订或proof扩容。保持历史failed/partial/no_record等状态，未重判。2x/5x 是原文长度同分布的容量复制数据，含唯一坐标重映射及嵌入JSON身份不一致限制，不能用于业务等价断言。空库保留称号字典和迁移记录。

本机 Apple M4（10 CPU、24GiB RAM）、macOS arm64、Node24.22.0、better-sqlite3 13.0.3、Drizzle0.45.4；每个被测进程 `--max-old-space-size=2048`。只运行一个本票性能命令；同机其他会话/OS负载没有隔离。不是1vCPU/4GiB容器结果，没有用5120MiB规避失败。冷态是新进程，OS缓存未清除。失败路径没有热态成功样本，不补零、不伪造p99。小样本分位数只描述观测，#91仍需受控环境长样本复验。

## 已证热点与调用链

1. **#84 企业列表/单企业详情，最高优先级。** `/api/roster/enterprises` 和 `/:id` → `listRosterEnterprises` / `getRosterEnterpriseDetail` → `readRosterContext` → `readSnapshot`（`lib/roster/enterprise-roster.ts:73`）。列表、详情均先取企业/记录/事件/出处/别名/导出行/全部关系/全部查询/差异，再缩到请求。单企业profile没有全算，并不意味着取数已限定。2GiB新进程在读取全部平台查询的 native `Statement::JS_all` 过程中 V8 `Reached heap limit ... heap out of memory` / SIGABRT。并发1/2/5均实际复现；即单企业也失败。最后成功的SQL边界已经读入约330MB，随后约902MB raw响应无法继续物化。最后边界内存只是失败前下界，不能当峰值。
2. **#83 平台分页。** `/api/platform/queries` / `list_platform_queries` → `lib/platform/read.ts:108`；已有WHERE筛选，但未限定查询时先SELECT全部列、全部命中查询，在JS计数并slice。第一页25查询仅返回约191KB，却读39337行/919336519字节，包含无关raw响应和全部命中collection_evidence。关系按页内query IDs读取，不能说关系也全表。精确queryKey已经有界；应保持现有全部关系、顺序、collectionEvidence、failed/partial/no_record语义。修复入口属于 #83；索引DDL归 #87协调。
3. **#86 来源目录与显式范围记录对比。** 目录 `listRecordComparisonSources` → `db.select().from(platformQuery).all().map(...)`（`server/utils/record-comparison.ts:207`）：小目录页仍取全部raw字段。对比 `getRecordComparison` → `sources`（同文件:112）先读取全部query/relations/export/document，再按ID过滤；仍全读record/evidence/events，且缺USCC时循环读取enterprise。单query ID+单enterprise测试读171513行/1248417738字节；不是查询条数多，而是包含无关大载荷。asOf/proof/历史不可用语义不能因优化变化。
4. **#85 对应列表，静态风险与实测有界点读分开。** `listRecordCorrespondences`（`server/utils/record-correspondence.ts:424`）先全表filter/sort，再为每行补来源，API之后才分页；当前0行无法实证大规模成本，结论待调查。`eventSource/relationSource/exportRowSource`按ID定位，`generateCandidates`已按显式queryIds/exportBatchIds取数，再按query读关系；样本内有界，不重复开“所有对应端点全表”缺陷。大量ID、长审计和候选跨乘增长仍需 #85数据夹具与量测。

## 全量结构、ORM/native SQL 与入口清单

[inventory.json](inventory.json) 为逐文件、逐行位置清单，覆盖70个REST route、37个MCP tool、204个相关文件；每个入口列owner、disposition及直接import调用链。扫描包含注释/Map候选，不把词法命中当执行证据。新增遗漏应重新生成清单并补结论，不能依赖人工列出的少数热点。结构、每列类型/可空/PK、FK动作、唯一及普通索引的完整信息在distribution；没进行迁移或索引试建。

| 入口组 | 实现/调用链 | 结论与归属 |
| --- | --- | --- |
| platform queries / MCP list_platform_queries | lib/platform/read.ts | 广域分页已证热点；精确键样本内有界；#83 |
| roster enterprises/detail/recognitions/differences/export | enterprise-roster / recognitions → readSnapshot | 列表/详情已证OOM；同链路派生清单/导出量测单列；#84负责浏览，导出单独#88切片 |
| records / enterprises/:id / quality / export | lib/query.ts（grouped分页、派生过滤、聚合） | 已有SQL投影/分页，不与台账全量snapshot混同；需独立观测分位数，额外缺陷列新子票，不扩大#84 |
| stats首次认定年份桶 | getStats的SQL聚合 + getFirstRecognitionYearBuckets → readRosterProfiles → readSnapshot | 统计桶复用#84同一全量快照，归#84共享读接缝；不能仅凭getStats的轻量SQL判整个端点安全 |
| legacy comparison / curated patch | lib/comparison.ts、comparison-platform.ts、curation.ts、reconcile.ts | 批量内存聚合、legacy JSON同步读写；归独立“旧对比/统计及离线文件”后续切片，不塞入#86记录对比 |
| record-comparison/sources/legacy-impact + MCP comparison tools | record-comparison → sources/read-source/proof解析 | 目录与选中范围已证热点；legacy-impact额外重复取source、全差异与循环enterprise，待单独profile；#86 |
| correspondences list/detail/source/audit/candidates/preflight/commit/batch + MCP | correspondence-route/API → core/read/candidates | ID路径样本内有界；列表全表和长审计待填充夹具；决策写入、revision/audit保留；#85 |
| comparison-scope-proofs list/detail/audit/preflight/commit/batch + MCP | proof API/core/source → 指定来源指纹/审计 | 当前0行，静态检查不等于规模通过；#86 proof读取协同，写事务/缓存归#89，若独立热点另票 |
| import preflight/commit/replay/duplicate-candidates + MCP | roster-import-route → HTTP/core/batch-ledger | 已有按键改进；预检仍会写import_batch账本，非纯读；#19保留，剩余共享处理按#88冻结切片 |
| export snapshots/list/diff | platform-snapshots-http → lib/platform-snapshots.ts | batch清单和单batch行查询已有限定；同批diff为容量对照，跨快照业务等价待验；导出处理#88，非同接缝另票 |
| live platform/query/batches/retry/item + MCP | platform batch/live/client/adapter + jobs | 外部请求、原始分段归档、checkpoint/retry；仅静态盘点，不访问平台、不触发生产任务；#88需独立离线服务夹具 |
| jobs list/get/create/delete/kinds | job-store → job-runner → render-pages/ocr/reconcile/platform-batch | list SQL count+limit；队列/activeJobs/cancelRequested为进程内；重启把活动任务标failed、不是自动恢复；恢复/长跑待#88/#91 |
| files/list/get/register/patch/delete/tus + MCP | stored-files/file-parts/tus；文件响应createReadStream | 元数据SQL count/page；HTTP文件GET/private缓存/Range为流式；冷回填会写库，readonly/空文件根有明确限制；#88按文件处理拆票 |
| OCR list/markdown/save/delete + MCP | ocr-files → ensureFileStoreReady → ocr-result；ocr job/API/cache | 库按file/page取，markdown组装整文件；元数据路径仍读取markdown/raw；冷ready回填不等同生产文件读取，单独诊断储存层；#88分片 |
| PDF pages get/post + page images MCP | pdf-pages → PDFium/sharp → manifest | PDF整体readFile，native资源、每页render；per-path串行/去重，不是全局CPU/字节限额；#88文件渲染独立切片 |
| credentials settings/reveal / health / OpenAPI guards | credential-state/API/auth、openapi-guard | 不压测密钥操作；仅检查契约和no-store。health轻count用于自有服务就绪；#89隔离策略，#91安全/契约验证 |

SQLite EXPLAIN已捕获：全量平台查询 `SCAN platform_query` + `USE TEMP B-TREE FOR ORDER BY`；四键查询 `SEARCH ... USING COVERING INDEX platform_query_identity_uq`；relation `(query_id,sequence_no)` 和 query前缀命中现有唯一索引；event id 命中INTEGER PRIMARY KEY；correspondence enterprise命中现有复合索引。**不能把给fullSELECT加排序索引当作消除raw物化**。#87应先与#83/#84/#86确定最终谓词/轻量投影，再决定复合索引、json_each代价、构建空间/WAL/写入收益；不盲目索引全部列。原文JSON/HTML均以TEXT存储，Drizzle JSON列在映射时JSON.parse；完整原文与结构化关系有重复，但本票没有授权删除或外置证据。没有根据SQLite类型弱约束改变null、rowid、唯一键或事务语义。

## #19 实际交付核验

#19仍为OPEN、无评论。源码 `roster-import.ts:2235–2332` 的findAliasRow/findQueryRow/findRelationRow/findDifferenceRow均按唯一键WHERE + id投影 + get；refCandidates只取query id，缺queriedAt时为索引前缀范围并保留“不唯一”语义。enterprise身份按USCC唯一索引、归一化名称索引查。EXPLAIN证明现有query identity是covering index，避免raw_response。现有 `tests/roster-import-scale.test.ts` 受 `ROSTER_IMPORT_SCALE=1` 门控，语义黄金用例在 `roster-import-semantics.test.ts`，不重复新增同一测试/缺陷。

仍有**不同**全量工作：`candidateTargetPathsByRow`相关规划会读record/events/evidence；sourceDocument upsert、record/event匹配仍有全表/集合查找；文件证据清单及部分ref关系查询按query读取整行。它们不是“findQueryRow每次全表取raw”的旧缺陷。#88只接本轮基线确认的具体剩余场景，若无共同窄接缝先拆import、files/OCR、export、offline job等独立后续票。当前新增query小载荷千条批量通过也不能证明千条大HTML+全关系写入已达SLO；不替#19做历史改前/改后验收或自动关闭。

## 缓存与资源归属

- DB连接 `db/client.ts:26` 的Map按绝对路径+readonly缓存，无TTL/显式关闭/容量；它不是查询结果缓存。固定路径常驻连接不等于已确认内存泄漏，动态路径增长需#89验证。
- 当前未发现通用服务端 roster查询结果TTL/LRU缓存；热态仍反复读大表，命中OS页缓存不能改变Node物化量。no-store的MCP、对应、proof、记录对比、平台任务和凭据响应保留。
- 前端Pinia Colada按namespace+参数（企业详情按id）缓存；useRetainedQuerySnapshot保留上一成功结果且校对捕获请求身份，失败时禁止错页翻页。局部patch会invalidate部分namespace；没有统一已提交版本失效矩阵。#89先画企业/别名/事件/原档/导出替换/对应/proof撤销到视图的矩阵，不共享敏感raw或把失败缓存为no_record。
- REST files模块backfilled与MCP/ocr ensureFileStoreReady的filesReady是两份进程标记，非按DB/root/版本的缓存。OCR/page cache按图片hash+模型请求variant+version核验，坏JSON视miss，原子写；没有总字节/TTL/淘汰预算。PDF manifest/页图驻磁盘，chains/inflight按路径串行/去重并在settle清理；文件HTTP private max-age3600。#89只负责明确的一种有收益缓存，磁盘清理/渲染调度若新增另#88子票，不合成大改。
- job queue/activeJobs/cancelRequested保存在进程内；OCR最多4个job，页与文件还有并发；同步SQLite和大JSON仍占主事件循环。外部OCR/平台耗时、native PDF/sharp峰值、进程重启/取消/磁盘缓存增长本轮不宣称通过。

## 验收边界与交接

聚合测量结果和实际执行命令/验证结果在下文补充。此次交付是调查候选，不是部署允许，也不代替父代理/#91的受控容器、全部公开HTTP/MCP业务等价、桌面/390px、长时混合负载及恢复验收。PostgreSQL #90只取本轮schema/SQL/资源证据，必须另补优化后SQLite对照，不能把同步全量读算法搬库当根因修复。

## 新发现的独立后续去向（未自动开票）

| 本地跟踪号 | 证据/窄范围 | 后续处理 |
| --- | --- | --- |
| F82-01 | jobs列表21条历史，SQL返回22行但约12.45MB；默认把任务完整params/result带入列表，约12.46MB响应。5并发热样本p95约1.23s、进程采样heap峰约802MiB、心跳阻塞约1.01s | 独立M票：任务历史轻列表+单任务完整结果兼容读取，保留旧消费者/错误/原始checkpoint；不把“已有LIMIT”当资源有界，不塞入#88所有处理改写 |
| F82-02 | snapshot diff的同批from=to对照，读取12548行/17324164B，响应630B；5并发热p95约593ms、心跳最大约593ms | 独立M票：明确全快照比较资源/索引/投影；同批对照仅容量触发器，尚不能推广至所有真实跨批输入或宣称确定缺陷已修；不扩大#83平台查询分页 |
| F82-03 | readonlyDB+空文件根：OCR metadata/markdown冷首请求500，后续200；并发2/5冷批分别[500,200]/[500,200,200,200,200]。ensureFileStoreReady把filesReady=true置于backfillFileParts成功之前，后者尝试写只读库 | 独立M票：只读OCR冷启动与失败ready状态；本轮环境特定失败不是“生产OCR不可用”。#89缓存矩阵登记该依赖，实际修复不夹入缓存算法票 |
| F82-04 | legacy comparison/record统计/导出与离线reconcile目标计划不是统一的record-comparison接口；不同SQL投影、文件缓存和全范围聚合 | 保留为父#81独立待分级项；以本轮量测决定是否开票，不能仅词法扫描就把所有模块判成同一全表缺陷 |

没有修改票状态/标签、没有新开GitHub票；父代理可把这些窄场景交给后续scope-gate分流。

补充定位：`/api/stats` 的首次认定桶、`/api/roster/recognitions`、`/api/roster/differences`、企业深页和roster Excel导出在同一全表snapshot路径也实际OOM，不只是列表/详情。`/api/records` 正常页则仅约173行/12376B SQL载荷；全范围quality约7297行/522153B，是轻列扫描，样本内资源正常。离线reconcile全量目标收集（未访问平台、未执行外部job）读取27770行/2549904B，5并发热批最慢约182ms、heap峰约121MiB；不能把这项规划速度当成完成外部核查吞吐。

F82-04现有量测进一步确认：legacy comparison先补全全范围证据再筛选分页，读36910行/55909771B，25行响应仍2885512B；5并发热最慢约2.04s。它有部分企业范围SQL，不是整张platform_query无条件加载，独立后续票应守该差异。另保留 **F82-05：记录Excel导出工作内存** 独立M候选：正常导出读74337行/5687857B、输出547507B，5并发热批最慢约3.90s、采样heap最高约738MiB；没有OOM，但超过冻结全量处理working-heap256MiB预算。ExcelJS整workbook/writeBuffer边界需与列表读取分开，不能顺带大改全部导出。

事件循环量测校准：新增仅诊断路由固定阻塞200ms，1并发心跳最大漂移约192–201ms，5并发聚集时约1004ms，能捕捉已知阻塞。早期v2/deep结果只有monitorEventLoopDelay直方图，个别热批reset后漏掉阻塞；保留原值并明确它不是“该热批未阻塞”的证据。后续矩阵同时给独立10ms心跳最大漂移。Node旧生代上限2048MiB，但 `v8.getHeapStatistics().heap_size_limit` 实测2348810240B（2240MiB，含其他空间）；报告使用具体flag与实测值，不称其为严格2GiB总堆限制。若#91要求总堆严格2GiB，需另冻结semi-space/容器约束并重测。

**2x的SQL临时磁盘证据**：完整78606-query/116620-relation副本（integrity/FK正常）上，未限定平台页的第一次SQL尚未返回，c1请求达到90s诊断截止（没有V8 fatal，不能称OOM）；c2重现期间对自有worker的lsof检查发现SQLite `etilqs` 临时文件883029462B。结合EXPLAIN的TEMP B-TREE，这是实际排序落盘证据，不能只归因JSON解析或只报查询总数。此时heap检查点只是SQL启动前约44MiB，不表示峰值很低。为控制主机资源，后续已知失败扩大规模路径用15s诊断截止，全部超时保留为失败；不修改应用timeout或放宽SLO。未完成的c2旧长批被取消，不计作成功样本。

验证环境异常保留：首次 `pnpm test --maxWorkers=2` 出现OCR UI用例约5.3s超时，以及record-correspondence-core worker终止超时；在主机并发工作树测试和高swap条件下中断，不能计作全套绿。未修改任何测试或timeout。随后同源码对这两个文件用单worker隔离复跑：2文件、70测试全部通过（22.82s）；这支持环境/时序影响假设，但不把它当作已证明全部根因或全套通过。具体最终门禁以最新日志/交接为准。

## 最终已执行矩阵与量化交接

[measurements.json](measurements.json) 包含309组诊断分组、12组编译后公开传输分组，逐组列input文件、场景、并发、冷热、样本数、成功/错误状态、观测p50/p95/p99/max、SQL调用/行/字节、解析/序列化/残余、响应/接收时间、heap/RSS/事件循环。失败35组，其中24组有V8 fatal签名；不把其余超时当OOM。1x共享snapshot七种入口各并发1/2/5共21个worker OOM；2x记录对比c5、来源目录c2/c5另3个worker OOM。1x记录对比c5冷批4个200、1个90s超时，因此未采到该组热态；不能仅用4个完成请求给整批贴“通过”标签。

| 1x诊断，固定输入 | SQL行 / 返回SQL字节 | 响应字节 | 单并发冷总耗时 | SQL / JSON.parse / stringify / 残余 ms | 采样heap / RSS MiB |
| --- | ---: | ---: | ---: | --- | --- |
| 平台第一页25查询 | 39337 / 919336519 | 191107 | 4142ms | 3435 / 28 / 0.67 / 676 | 1817 / 2237 |
| 来源目录第一页50 | 39309 / 919171763 | 16580 | 2007ms | 1379 / 25 / 0.04 / 599 | 1813 / 2261 |
| 单query+企业的记录对比 | 171513 / 1248417738 | 7006 | 7997ms | 4086 / 1690 / 0.03 / 2216 | 1824 / 2279 |
| 单企业详情/企业列表 | 失败前139594 / 330102537，后续SQL未完成 | 无成功响应 | OOM | 不能把中断点伪装完整分段 | 最后检查点只是下界 |

上述时间为诊断adapter、当时主机负载，不是容器或公网SLO认证。平台c5冷最慢60822ms、热样本p95 25267ms；深页c5冷/热最慢27179/29456ms。解析量与响应量明显小于读入原文，SQL投影与请求范围是明确去向。

2x副本已完整生成并通过integrity/FK：14594企业、40946记录、43400事件、78606查询、116620关系、20042导出行，2,685,665,280B。额外独立SQL确认raw_response=1,804,673,384B、relation.raw_fields=531,902,306B，均恰为1x两倍；测后回收自建副本，保留manifest及结果。精确键/事件/关系保持完成且取数有界；凭据表在复制器中清空，所以source点读少了固定凭据元数据行，不能要求其SQL总行数与未清空1x完全相等。广域平台/企业/对比/目录在15s截止下失败（有部分V8 OOM签名）；1x 90s与2x 15s的截断不能直接比较为正常分位数。

**5x未完成**：首次未完整生成的自建副本已回收，未用于测量。再次容量预检可用6,867,189,760B，CoW种子之外预计仍需5,369,413,632B，并保留4GiB；不足以安全生成完整5x。[fixtures.json](fixtures.json)保留精确拒绝及阈值。生成器可复现，但没有5x运行或5x无OOM证据；#91须在足够容量/受控限额上补齐。没有删除其他工作树或用户数据来腾盘。

空库实际335872B，保留迁移与称号字典；列表/统计正常，固定不存在企业/event/relation为404负例，未拿负例当未解决业务错误。正式副本未丢未匹配行，24/28个注册源文件成功复制并通过保存的sha256/大小核对（113002515B），另4个源文件本机缺失并保留元数据；不是完整文件语料验收。写副本使用原生clonefile，源与目标inode不同；Node本机强制CoW接口曾返回ENOSYS，已用实际成功的原生操作替代，没有依靠未实现接口宣称复制。

#19当前千条对照：HTTP预检N=1/300/1000分别4/303/1003次SQL，提交N=300/1000分别903/3003次SQL；这是现版本同输入量级比较，不是历史改前对照。c5热预检1000的p95约959ms、SQL返回仅98B；提交1000的p95约2630ms、SQL返回8095B、heap峰约127MiB。300行预检/提交p95约175/595ms。每条预检均明确无conflicts且add=N，每条提交status=committed/failed=0/written=N；不是仅看HTTP200。观察WAL最大4482592B。这里只用小raw/no-relation的新查询，验证查找不随已有902MB原文膨胀，不代表千条大HTML+全关系、失败恢复或多进程锁竞争都通过。c5混合为3提交+2精确读，同时入站、单worker同步DB；热批最慢约14ms。既有 `ROSTER_IMPORT_SCALE=1 ...roster-import-scale.test.ts` 四项通过（6.11s），#19保持OPEN。

实际文件正文handler使用私有源文件副本：18,445,656B正文在c5热15样本p95约160ms，其中接收p95约151ms，采样heap峰约35.5MiB；没有全文件进JS堆。可写副本+文件根上的files/OCR metadata/markdown冷/热均成功；这与只读冷回填500场景分开，未更改生产代码。OCR元数据仍读约541246B（97页正文/raw）只返回26918B，当前样本资源尚有界；超长PDF/真实OCR、解析、任务取消/重启、上传与缓存磁盘长跑留#88/#91。

**编译后真实HTTP/MCP**：`pnpm build`成功，启动自有loopback Nitro、readonly完整副本、2048MiB旧生代、外部fetch禁用；并发1/2/5，各冷1轮+热5轮，共96请求、36批。所有响应200、MCP无RPC错误，完整解析结果HTTP/MCP/跨轮hash相同。HTTP热p95为7.6/11.5/22.1ms，MCP为7.0/13.5/29.5ms；c5观测p99为23.6/32.1ms。HTTP响应98236B，MCP含协议包装213779B；c5采样结束heap分别约93/108MiB。这仅证明精确查询键路径，不能替代广域目录/企业OOM结果，也不能替所有37个MCP tool认证。

固定候选样本选择的企业与最大原文查询未必有匹配边，返回候选很少；它证明显式来源的取数范围，未覆盖高命中/长历史的候选跨乘开销。当前对应与proof空表仍是明确规模缺口。

## 验证记录与剩余边界

生产应用源码仍为d198a09时执行：`pnpm test --maxWorkers=2`最终重跑 **137文件通过、2跳过；2063测试通过、11跳过，117.21s**；首次超时/中断记录仍保留，未改timeout。`ROSTER_IMPORT_SCALE=1 pnpm vitest run tests/roster-import-scale.test.ts --maxWorkers=1` **4通过，6.11s**；`pnpm typecheck`退出0；`NODE_OPTIONS=--max-old-space-size=2048 pnpm build`退出0（19.9s）；编译后自有Nitro公开HTTP/MCP **36批/96请求通过**，完整解析结果跨HTTP/MCP及轮次一致。所有新MJS通过node --check，Python脚本通过AST解析，实际snapshot/profile/inventory/scale/receipt/file复制/transport路径已执行；未把未执行的5x计作通过。

原始命令和输出在 `/tmp/ningbo-perf-81-89/evidence82/`：`tests.log`首次失败、`failed-files-rerun.log`70项复跑、`tests-rerun.log`全套最终通过、`scale-tests.log`、`typecheck.log`、`build.log`、`public.jsonl`及各baseline JSONL。可分享聚合数据已入仓库，私有路径可能随临时清理失效。原始商业资料、数据库、凭据、selector及stderr没有提交Git。

尚未完成/不可宣称通过的验收项：5x完整副本和全矩阵；严格总堆2GiB/1vCPU/4GiB容器；可靠人口p95/p99长样本与长期内存；真实多进程SQLite并发锁/WAL恢复；全量大HTML+多关系写入及中断重试；有实质命中/长历史的对应/proof/候选；缺失4个源文件、PDFium/native OCR与外部OCR/平台服务、上传及取消/重启、磁盘缓存增长；全部MCP tool语义及桌面/390px交互。它们作为#88/#90/#91及独立F82后续切片的明确输入；本调查不完成母票或部署验收。
