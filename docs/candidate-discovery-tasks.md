# 公布事件归档候选任务（#214）

## 71611 目标结构接缝（#747）

候选服务在已完成离线迁移的 71611 SQLite 上使用 collection、observation、当前 assignment、三来源结构化投影和外部 query/relation 别名。公开 ID 仍是别名；任务参数、行检查点、幂等键及 archiveGeneration 不改为内部主键。普通 expand schema 的既有分支保留，全局 runtime、worker、importer 门禁继续关闭。

`generateCandidates` 按原业务内容版本分组，在 SQLite 内筛选、计数及选择业务组后，读取所选组的全部观察。`discoverEventArchives` 则保留原行分页和独立 coverage 分页/计数：认定目录按成功页称号分区，关联办理和申报按既有查询称号规则。两入口不共用猜测的 effectiveTitle。候选字段来自各来源 reader；原档仅用于证据展示、既有指纹及资源字节核算。候选调用显式将 reader 的 capture 检查限定在所选观察，避免每个事件重扫整个来源；关联办理 reader 的默认全来源检查契约保留。

目标结构的单来源 4 MiB 检查合计 collection 所属 rawResponse、collectionEvidence 与所选 observation 所属 rawFields 的原存储字节。request、legacyRowSnapshot、canonicalRawJson 不重复计费。逐行事务、已有决定保护、25 行检查点、200 事件续片、取消/重启后的显式重试及 #746 年度接力沿用既有实现。

`enqueueArchivedCandidates(..., true)` 可在目标 collection writer 的事务中独立 staging；事务提交后调用 `activateCandidateDiscoveryTasks`。按外部 query ID、最后一条外部 relation ID 和原规则版本去重。此接缝不全局切换采集导入，也不许可向同一采集坐标追加原行。完整 record-comparison/discovery catalog、资格、其它 job 引用外键及旧表退役仍属后续消费者。

## 既有任务与资源契约

`POST /api/roster/correspondences/tasks` 返回 202 和 `jobId`。沿用 API token；同源任务页沿用任务中心浏览器来源检查，不接收浏览器凭据或自由输入操作人。后台行为记录为 agent / candidate-discovery-job，不冒充真实用户。

请求必须有 `clientRequestId`，范围恰选一种：`eventIds`（1–200 个正式事件）、`titleCode`（little_giant/specialized_sme/innovative_sme）或 `queryId`（已归档查询）。可用 `afterEventId` / `throughEventId` 指定有界续片。首次执行冻结最高事件 ID 和最多200个匹配事件，逐页25条候选，单行事务串行提交，逐行让出事件循环。称号范围需显式继续下一片；归档影响范围超过200条时以相同任务类型继续，回执保留后续任务入口。事件与候选页检查点使用既有 job.result，不新增表或迁移。

任务中心 `/tasks?tab=platform&job=…` 显示范围、成功/待核/失败、候选新增/保留数量、规则版本和逐事件入口。任务完成只说明生成工作完成，不能作为确认对应。事件入口继续使用现有公布出处、平台原行和关系读回。`GET /api/task-center/:id` 与 `GET /api/jobs/:id` 提供摘要/原检查点；任务中心的 cancel/retry 复用现有控制。最多10次执行；重启把中断任务标失败，显式重试保留已完成事件和页内行位置。规则变化需新任务，不重放旧版本检查点。

MCP 使用 `submit_event_archive_candidate_task` / `get_event_archive_candidate_task` / `retry_event_archive_candidate_task` / `cancel_event_archive_candidate_task`，调用与 REST 相同应用服务和任务队列。提交、取消、重试受现有 MCP token 门禁保护，读取可匿名。

归档导入仍经既有领域事务。独立导入进程只在归档事务中写入一个按 queryId+末条原行ID+规则版本去重的 queued job；应用进程收到导入回执后接管同一任务队列。原进程中断不会丢失已提交的任务记录；启动对账后通过任务中心显式恢复。导入幂等回放补回同一任务入口，不另造候选账本，也不在归档事务里执行发现工作。

自动续片在内部参数 `archiveGeneration` 中保留起始任务 ID；所有后续片以该代际、queryId、游标和冻结事件上界去重，取消、重启后显式重试沿用同一代际。当前公开导入不允许同一采集坐标追加原行：预检与提交均拒绝 `query_relation_set_conflict`，提交零业务写入且不返回候选任务；合法新观察须使用实际新 `queriedAt`，产生新的 queryId。历史存储中同 queryId 的末条原行发生增长时，内部 staging 按末行 ID 生成新起始任务及整条续片链，不复用旧代际的已完成续片；这不是公开追加原档的许可。导入收据的预留与执行两段写事务均在读取前取得写锁，避免自动候选并行提交使延迟事务的读快照无法升级为写入；不改变业务事务、指纹或审计内容。

#389 的回归分为两个独立场景（静态候选阶段均 UNRUN；2026-10-27 首次单次联合运行，两例 PASS，exit0）：

- A：`rejects same-coordinate archive append and recovers a legal new observation with idempotent public replay` 保持原进程内 `commitRosterImport` 入口，先断言原同坐标 sequence2 被拒绝且旧来源、关系、投影、对应、审计与任务不变，再仅将第二观察时点改为 `2026-10-18T00:00:01Z`。旧引用和新 legacy 观察仍省略 raw/collectionEvidence/reuseExisting，已存原 raw 完整保留；同键回执及换键的相同请求重放保持任务与审计幂等。此场景的两个 queryId 不同，不声称检出同 queryId 的代际去重碰撞，也不声称 HTTP/native 传输覆盖。
- B：原名 `processes appended archives across all continuation generations and deduplicates replay after checkpoint recovery` 专门覆盖历史同 queryId。父批准的 source-only 合成夹具例外仅在旧三片 DONE 后插入原 2022 字段的 sequence2，旧 query/raw/row1 不变；正式 `platformRecordObservations` 预检/提交建立其真实的 `missing_key/unverifiable` 投影，不伪造 canonical 行或 verified 身份，也不冒称自动 stage。随后只调用既有 `enqueueArchivedCandidates(..., true)`，在真实 immediate 事务提交后 `activateCandidateDiscoveryTasks`；年度仍由真实候选检查点事务自动 stage，不手动补片。第二代及重复 stage 是内部接缝回执，不是公开 append 成功回执。

两场景都固定原 401 个事件；两代各三片 DONE、items `[200,200,1]`、through 为输入 `eventIds[400]`、after 为 `[0,eventIds[199],eventIds[399]]`，新链与旧链 ID 不交，children 的 `archiveGeneration` 等于新 root。新 child 必须存在、处于 running 且已持久化新候选后才取消；旧 child、缺 ID、异常终态或错过取消窗口立即失败。保留原一次显式 retry、attempt2、每事件两条关系、新 candidate 单条审计、旧尾 rejected 与旧审计全等；B 重复 stage、A 公开重放后都逐值比较完整任务和业务快照。原 60_000ms 不增加；所有新增等待共用 case 开始的 deadline（提前 250ms 留日志余量），记录 await 进入/离开、root/child 轻量检查点、取消终态及 afterEach 阶段，缺失元数据保留 null。既有共享 fixture/teardown 和其它 case 未改。

阶段证据：grant `stage04-389-own-setup-two-targets-bail1-once-20261027-r4` 下只运行一次两个精确名称的联合 regex，single worker、bail1、default+JSON；结果 2 PASS / 20 filtered SKIP / 0 FAIL，进程自然 exit0、signal=null。B 原名场景 31,785.215ms，两代同 queryId=1；A 场景 29,479.454ms，合法第二观察 queryId 从1变为2，非法同坐标请求仍为预期拒绝。两例均实际观察到新 child running 且 durable created=1 后取消、cancelled、原一次显式 retry 后 attempt2，以及 local afterEach idle 进入/离开和最终 afterEach.finished；两例均在原60s内结束。没有执行 generation mutant，A 不作为同Q碰撞检错证据。完整原始日志、JSON、phase、源/原件保全与 immutable release 见 Git 外 `/tmp/stage04-389-two-once-14fa379a/`；1798 tracked 与74份原件在运行前后 hash 全等。原始 JSON 未提供显式 unhandled 计数，该字段仍 UNKNOWN；原始日志未见 unhandled 错误段，不推断全机 jobs/handles/listeners 为0。

本段为运行后文档记录，不是执行输入：执行时测试源 SHA256 为 `8a3be1e5101f8caca900293853039173910941e847517890d4d9b104bb0ef41a`、文档为 `770e71254e7f3474189ed5ed9cca2158e6d249c046e07a56f204a51ae38f728b`；通过后只更新当前结果句，测试代码和其余运行输入字节未改、没有重跑。type、整文件/full、HTTP/MCP/native/browser/build 仍 UNRUN。原 full 固定 123c 的 5058 PASS / 34 FAIL / 19 SKIP / exit1、原本例 60000ms timeout 和注册栈 `STACK_TRACE_ERROR`、原 await/cancel/retry 到达情况 UNKNOWN 均保留，原两轮 connector404 与不存在路径 rg exit2 也保留；后续执行需另授 slot，任何 unexpected FAIL 保存原件后 STOP，不现场修复或重跑。

候选复用 `discoverEventArchives` 的 event-archive-212-v1 规则。持久化只调用现有 preflight/commit，保存原始来源指纹、出处和追加审计。每行提交前，在同一 immediate 事务内再次检查该事件/原行的所有已有角色；candidate/confirmed/rejected/unlinked 和更正历史一律保留，不以新规则静默重新推荐。发现后发生的身份、来源、版本变化仍由领域预检/提交拒绝并报告失败。

资源边界：队列沿用非 OCR 任务独占规则，不新增并行执行通道；每任务最多200个事件检查点。增量影响筛选与单事件发现直接共用 USCC 的 SQL 归一化规则。

内存政策（按最新用户澄清）：避免全量归档水合；允许现有领域服务水合当前选中的单个来源，用实测资源调整处理限额。完整 query/relation、provenance 的 JSON.stringify/SHA256、来源快照和追加审计沿用原算法及原字节。这里不宣称零单来源水合或通用恒定内存。此前“F1 必须先建设共享 JSON 序列化/存储架构、不得调整1 MiB”的结论已被此政策取代；原 >1 MiB 来源导入成功却在任务及重试中失败的历史记录仍保留。

当前任务支持单来源三列 SQLite UTF-8 存储字节合计 **≤4 MiB（4,194,304 字节，含边界）**：query.raw_response + query.collection_evidence + relation.raw_fields；JSON 列按实际序列化存储计算，空值为0。进入现有领域服务前检查，串行逐行处理。该限额是当前任务的实测处理范围，不改变导入/领域接口可接受的来源，也不是普适内存保证。大来源在单行事务期间仍会暂时阻塞事件循环，取消在行间生效。

2026-10-23 本机 Node v24.22.1 / Vitest4.1.11 独立 fork 测量（合成隔离库，无生产写入）：

| 实际三列合计 / 内容 | 领域预检+提交 | 任务耗时 | 任务采样 heap / external / RSS 增量 | 任务进程最高 RSS |
| --- | --- | --- | --- | --- |
| 128 KiB，rawResponse | — | 16 ms | 14 / 0 / 4 MiB | 281 MiB |
| 1 MiB，rawResponse | 21 ms | 28 ms | 33 / 0 / 30 MiB | 283 MiB |
| 4 MiB，三列分摊 | 89 ms¹ | 102 ms | 70 / 0 / 97 MiB | 370 MiB |
| 4 MiB，转义及多字节内容 | — | 170 ms | 76 / 0 / 116 MiB | 388 MiB |
| 4 MiB，rawResponse 全 NUL（快照转义膨胀） | 509 ms | 527 ms | 106 / 0 / 342 MiB | 607 MiB |
| 4 MiB，三列分摊，另有2,000份各64 KiB无关归档 | 85 ms¹ | 98 ms | 70 / 0 / 92 MiB | 390 MiB |
| 每份4 MiB全 NUL，同进程串行4个事件，另有2,000份无关归档 | — | 1,817 ms总计 | 108 / 0 / 329 MiB | 620 MiB |

补充单列轴：collection_evidence 与 raw_fields 分别从128 KiB、1 MiB、4 MiB增至8/16 MiB（后两档仅调用领域，不提升任务限额）；4 MiB领域耗时分别88/88 ms，任务耗时118/98 ms，采样heap增量76/71 MiB、RSS增量81/95 MiB。2,000份无关归档组的驱动返回观测未发现任何无关原响应正文；这只是该查询样例的观测。

¹ 领域测量该两组实际为4,194,331字节；任务测量均调齐到4,194,304字节。另测8 MiB全 NUL的领域预检/提交约983 ms、RSS增量740 MiB、进程峰值1,020 MiB，因此选择4 MiB保留余量。独立只读备份副本中39,303次查询的两列最大104,919字节；加上每个所选原行 raw_fields 后58,310份来源合计最大110,350字节（其中raw_fields为5,431字节），均小于当前范围。这是2026-10-22备份分布，不代表实时生产或未来来源上界。

方法与限制：每组全新 Vitest fork，建好合成数据后显式GC，记录基线；在SQLite语句边界及领域调用结束时采样 process.memoryUsage，process.resourceUsage().maxRSS记录进程峰值，performance.now记录执行时间。最高RSS含测试运行时和准备阶段；采样heap/external/RSS增量不是所有中间分配的绝对峰值，0表示该组采样未超过基线，并非无外部分配。四事件测量只验证该串行样例；不外推为长期负载/SLO。普通来源在增加约125 MiB无关归档后采样heap仍约70 MiB，结合按身份分页读取路径，支持“未全量水合原档”的判断，不消除当前来源完整水合及快照放大的成本。

超限反馈：此原行不提交，错误码仍为 source_materialization_limit，原档和同事件此前已完成的候选/审计保留。任务错误明确说明4 MiB任务处理上限，以及“原档不变时重试仍会失败”。重试沿用检查点而不跳过此行；按原行核对不保证自动任务完成，也不建议裁剪或改写原证据。未来遇到真实超限来源时，先测量该来源再调整处理范围。本次覆盖原 >1 MiB 有效来源首次完成及取消/恢复/重试，未新增解析器、配置系统、指纹迁移或快照存储架构。

部分失败逐事件记录安全错误码；任意异常原文和凭据不进入任务中心摘要。生产回填需另行授权，本票仅在独立备份副本与合成边界上验证。
