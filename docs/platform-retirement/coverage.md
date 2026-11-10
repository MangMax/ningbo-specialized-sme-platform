# 退役覆盖、分票与验收计划

状态：[#707 已独立静态接受](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/707#issuecomment-6771581483)。接受范围仅架构与契约；运行迁移及完整退役尚未接受，按后续各票独立验收。生产切换及删除仍需最终单独批准。

## 第一实施前沿

T01 是第一 schema 票，仅依赖 A0 独立接受。允许改 schema、生成 migration 和限定升级 fixture，不启动 source writer、不读生产、不迁 observation、不接 archive、不切运行 reader。明确交付 collection、page、unfinished、condition、limits 字段以及重建现有 scope/error 两表的 FK，结构及键见[契约](contract.md#标识与存储)。

过渡 schema 不能破坏旧 writer：expand 阶段暂保留 scope/error 的 query_id FK，新增 nullable collection_id 与目标唯一索引；旧触发器继续只写旧列。升级工具填好一一映射后原子重建为目标 collection_id PK/FK，再由目标 writer 接管，撤除旧 trigger。不得在首张票把历史 query 删除，或启动新旧 scope 双 writer。T01 的 fixture 覆盖空库、旧 query success/no_record/failed/not_queried/partial、重复/0行/失败页、多 title、JSON5二次解析和 malformed error；独立 oracle 直接沿用 migration0027 的旧表达式，不调用新提取器生成期待值。新结构失败必须整笔 schema 迁移回滚；旧写入仍可工作。

T02 归档及别名 schema 可与 T01 并行，不依赖 page、observation 扩展或整套消费者审计。别名→observation FK 的最终重建在 T05 完成（T03a 仅 expand），初始用尚存旧 relation 验证，不提前宣称无旧 FK。T04/T05 才负责旧数据传输。这样 T01 不承担原研究 A2/A3/A4/A5 的所有工作。

## 每票共同的门槛

每行给出外部行为、独立 oracle、失败或回滚反例以及该票允许删除的边界。未点名的旧 owner 均不得由该票顺手删除。数据升级只操作隔离一致副本，提交保存 source binding、source/target 行与字节 manifest、精确 SHA/tree。读切片固定同源同日、全部 filters/counts/order/options 对照；写切片覆盖公开 preflight/commit/replay/conflict 与 receipt，故意在中途失败验证无半笔写入。原 FAIL、UNRUN、UNKNOWN 独立保留。表中 oracle 和演练均为未来验收，不是本轮执行结果。

生产写切换前 W/R/H/C/X 票必须整体闭合，不能部署“新 writer + 未切旧 reader”的版本；各票可独立在副本 review。实现阶段临时测试参数只能位于 upgrade/test，终态 runtime 不得保留选择器。

| 票 / 上限 | 交付边界、外部行为与所有者 | 依赖 | 独立 oracle；失败/回滚；删除门槛 |
|---|---|---|---|
| T01 M | collection/page/conditions/unfinished/limits + scope/error FK 过渡，schema-only | A0 | 第一前沿所列旧SQL oracle；故意非法页整批回滚；不删旧实体 |
| T02 M | BLOB archive、类型化字段 refs、两 namespace aliases；bounded evidence 原文读取 | A0 | 原SQL cast字节及旧DTO；NULL/空/非法/Unicode截断/错owner；不删原正文 |
| T03a M / #710 | 同表 observation nullable 目标身份/位置及 assignment append-only schema expand；保留旧 PK/FK/读写/T02 refs | T01,T02 | populated0048 与 fresh schema/invariant oracle；无 collection 映射仍可升级；不转移数据、不切入口 |
| T03b M | 三投影 owner 分支、source title/normalization/reconciliation 字段及版本 archive FK | T03a | 三来源独立字段与类型/CHECK oracle；不夹带历史转移 |
| T04 M | source-bound collection/page/scope/condition/原字节转移工具 | T01,T02 | 旧自然键/JSON5表达式及逐字段bytes；source漂移拒绝续跑；仅升级工具读旧query |
| T05a M / #713 | 离线 observation 身份/位置/原键、当前 assignment revision1、观察 archive/alias 与 checkpoint；见 [边界及已接受结构前置](t05a-observations.md) | T03a,T03b,T04,#714（已接受） | 原SQL字节/DTO、全PK、重复观察、回滚/漂移；未索引以 paired not_indexed/SQL NULL 转移；真实悬空引用逐项阻塞；保留过渡 relation_id PK/FK |
| T05b M | 三源逐观察投影与 canonical 版本原文转移，包含 verified/shared-version 及 raw-only | T05a | 每来源独立字段/类型及原版本/hash/bytes oracle；不得用 snapshot 作业务 fallback |
| T05c M | 最终独立 observation PK、全部 FK/NOT NULL 重建、双向映射及旧 relation_id/T02 ownership JOIN 清除 | T05a,T05b | T05原最终全PK/归属/hash/引用门槛不降低；后续 W/R/H/C/Z 依赖完整 T05，不以 T05a 切片替代 |
| W1 M | apply source writer 与统一导入事务接缝 | T05 | 申报公开命令、year空白/类型oracle；same-key异payload回滚；只移除apply旧写分支 |
| W2 M | process source writer | T05 | 业务year/personuuid/whpc独立原行期待；跨接口同key不合并；只移除process旧写分支 |
| W3 M | recognized source writer | T05 | false/NULL/空白/未捕获保真oracle；源保真冲突回滚；只移除recognized旧写分支 |
| W4 M | import reuse/replay、归属更正、duplicate merge、113 capture写接缝 | W1,W2,W3 | 原公开回执及归属前后manifest；合并冲突不得部分转移；移除最后旧query/relation写入及触发维护 |
| W5 M | live/batch segments、重试/取消、job collection binding | T04 | 独立已接纳页序与unfinished集合；重启不重收成功页/不改pageSize；不删除历史job JSON |
| R1 M | declarations列表/详情/options，Drizzle匹配版本及全记录计数 | W1 | 旧公开DTO与独立version集合；同版本多观察/多归属冲突；删除apply旧join |
| R2 M | processes列表/详情/options | W2 | 同R1并逐项事项/业务年反例；删除process旧join |
| R3 M | directory列表/详情/options/冲突 | W3 | row/query/page冲突和raw-exact/display区别；删除recognized旧join，不授予正式资格 |
| R4 M | 当前候选 union，保留 #702 单次枚举及 #691 依赖读取 | T05 | 独立 title 候选PK集，含record/difference/correspondence/unassigned；无投影不消失；移除legacy candidate union |
| R5 M | recognized qualification witness、batch page metadata读取 | R3,R4 | 原保真语法及固定asOf全筛选；unknown不变false、不跨revision缓存；删filter env与pages JSON业务读取 |
| H1 M | correspondence、difference refs、alias sourceRef和历史DTO解引用 | T05,T02 | 旧具体观察/角色/owner/event/修订集合及audit bytes；同version不能扩授权；重建对应FK，删旧事实adapter |
| H2 M | comparison proofs、113 impacts、114 review指纹与来源绑定 | H1 | 独立旧hash envelope算法及旧保存digest；篡改source仍拒绝/重核；删旧query/relation读取，不改旧hash |
| H3 M | annual process closure、final、candidate discovery来源转接 | R2,H2 | 完整业务历史/潜在query闭包和唯一final oracle；冻结checkpoint不冒充current proof；删旧annual SQL |
| H4 M | import/enterprise/export三worker入口及job/receipt版本化ref解析 | H3,W4,W5 | 原任务params/result/receipt字节+packed worker入口；schema/file owner变动拒绝、restart/cancel；删动态旧runtime依赖 |
| C1 M | enterprise详情/台账/列表证据转接 | R1,R2,R3,H1 | 独立企业/title集合与原detail DTO；分页与unknown；删除旧enterprise证据reader，正式事实规则不改 |
| C2 M | comparison/difference附件、来源列表、USCC研究读转接 | R1,R2,R3,H1 | record分区 membership、原排序/count/代表MIN(id)；snapshot-only不得新增差异行；删旧附件selectors及归档业务join |
| C3 M | evidence HTTP/MCP、discoverability、client/skill字段指引 | C1,C2,R5,H4 | public served OpenAPI+SDK与真实读回、旧ID配对/64KiB oracle；invalid与replay错误保持；删旧schema枚举导入和旧contract adapter |
| C4 M | 清除其余14组遗留runtime selector及旧consumer adapter：official presentation、enterprise fact effects、correspondence useSourceFacts、setup useDb的runtime调用 | C1,H1,H4 | 每个开关原两路同输入oracle，已接受typed行为不变，历史unknown保留；移除环境/内部fallback及runtime setup调用，upgrade/test与显式历史资格规则版本不算fallback |
| X1 M | 三称号异步工作簿、worker发布/重生成 | R5,H4 | 公共submit/progress/download+独立ExcelJS逐表行集合与cells；取消/重启不发布半成品；旧workbook仍可下载，删运行旧candidate路径 |
| Q1 M | F03 台账最小derived filtering、选中页evidence | A0 | 独立lifecycle/firstYear/dueYear全counts/order；空页与深页；替换全量hydration，不删领域规则 |
| Q2 M | F04 district页内evidence | A0 | 原全局分母及独立页集合；同snapshot更正；删全evidence扫描 |
| Q3 M | F05 annual紧凑汇总+所选年度详情 | A0 | temporal precision/unknown/conflict/year totals独立计算；不造历史snapshot；删全年详情保留 |
| Q4 M | F02/F06 qualification请求内批量依赖复用 | R5 | role/version/day独立见证及SQL call/row预算；两请求间更正必须可见；删per-witness页读取 |
| Q5a M | F07/F08 apply聚合与ORM | R1 | 相同filter/count/matched version oracle+查询计划；深页版本/观察数区别；删apply整段SQL |
| Q5b M | F07/F08 process聚合与ORM | R2 | 同Q5a，按process字段；删除本源重复聚合SQL |
| Q5c M | F07/F08 recognized聚合与ORM | R3 | 同Q5a并含scope conflict；删除本源重复聚合SQL |
| Q6 S | F10/F11等价纯函数、Map/Set/es-toolkit整理 | A0 | 空白/类型/稳定顺序/first-last显式例子；hash serializer不动；只删证实冗余实现 |
| Z1 M | 全部映射及target-only shadow接受账本 | C3,C4,X1,W4 | 全PK/byte/ref双向manifest及同输入公共输出；任何未覆盖owner阻塞；不物理删表 |
| Z2 M | 清除全部legacy运行selectors/adapters/triggers/FKs及raw业务解析 | Z1 | runtime reachability+打包入口清单，故意旧schema不存在；禁止静默fallback；只保留upgrade/test oracle |
| Z3 M | 物理退役迁移与post-cutover rollback副本演练 | Z2 | sqlite_schema/FK检查，六正文表实际内容清单，新增写/receipt/ref双向逆迁移；DROP两混合表及已转存六附表，无view替身 |
| Z4 M | 原14组+新增owner最终集成验收与生产审批材料 | Z3,Q1,Q2,Q3,Q4,Q5a,Q5b,Q5c,Q6 | 固定SHA/tree、全公开输出/重启/工作簿/desktop390及性能；保留B409/705 FAIL和UNRUN；不含生产执行授权 |

图上每条依赖都是输入或可验证行为依赖，不以“同仓库”强加串行。T01/T02 并行；W1/W2/W3 并行；R4 无需等全部业务读服务；H1 无需等业务列表切换；Q1/Q2/Q3/Q6 无需等物理迁移。W5 不依赖三源写入，因为它仍是传输任务。Z4 是最终接受工作，不承载未完成实现；任一候选超 M 时按同源同owner拆分，保持上述 gate，不能降低覆盖。

## A0 独立审查修正后的必验反例

T03a 准备 source_relation_key 列，T05 原样转移；T03b/T05 必须按契约实现未trim的行称号类型和值，以及**所有观察**的本源stored/source/reconciled/conflict字段，不能仅为无版本行建立观察分支。W1–W3和R1–R3同步生成/读取；H1/H3验收具体消费者。三个独立oracle为：相同relationKey但raw.id不同的冲突观察年度闭包；多称号范围下数字2与空白字符串“ 2 ”不同的归属，以及query=1,2下true/false在SQL整数1/0入口与直接JS拒绝布尔入口的差异；共享verified版本但旧stored.status不同的两个观察仅一方platform_field_conflict。T05也须覆盖raw-only无版本值。原blocked评审保留，文档修改不代表运行验收或独立复核已通过。

## 原14组与新增消费者覆盖

历史 #455“本阶段已切换”是继承事实，以下是 **#706 目标责任**，不是回填历史PASS。组2、12原先不切；本次组2必须切，组12保持独立日志/凭据语义但验证无隐式旧模型依赖。

| 原组 | 本次必须覆盖的入口与目标 | 票 / 删除与独立接受边界 |
|---|---|---|
| 1 三业务、企业、comparison、difference | 三源本地服务、`enterprise-roster`、`comparison-platform`、`difference-list`、来源列表、USCC research | R1–R3,C1,C2；旧membership不变，所有证据target-only |
| 2 来源/采集 | `platform-live-query`、`platform-batch-query`、统一导入、`lib/platform/read`、`evidence-read`、legacy supplementation | T01–T05,W1–W5,C3；失败/空结果/原字节/页与alias完整 |
| 3 正式事实 | official-evidence、legacy ledger/detail/sync export、correspondence来源 | C1,C4,H1；正式出处、资格与旧presentation selector逐consumer检查，平台迁移不重写正式事实 |
| 4 企业主体 | enterpriseAlias、duplicate merge、enterprise-fact explanation refs/effects | W4,H1,C1,C4；观察级归属审计与解释引用原样，事实领域规则不改 |
| 5 对应/年度 | correspondence read/source/provenance、proof、annual process/final/candidate | H1–H4；同业务全部历史观察和授权闭包 |
| 6 当前资格/导出 | current candidates/qualification/query/workbook/HTTP/MCP/UI | R4,R5,X1,Q4；保留accepted691/702，全部三份下载工作簿 |
| 7 文件依赖/恢复 | stored files、freezeFile/proof、job artifact依赖 | T02,H2,H4；不将可变文件库当immutable archive，不改source files |
| 8 OCR/解析 | paid/OCR checkpoint、inputRef、parse依赖及render job | H4,Z4；只核无混合runtime/ref丢失，不启动付费OCR或新业务 |
| 9 tasks | job-specs registry、batch/reconcile/candidate/annual/current-export、job summary与checkpoint | W5,H3,H4,X1；历史未知kind仍unknown，restart/cancel/retry全涵盖 |
| 10 HTTP/MCP | import preflight/commit/replay、平台查询、列表/evidence、对应/年度/决定/impact endpoints | C3,H2,Z1；served discovery与领域契约一致 |
| 11 skill/client | roster ingestion skill、public SDK、旧ID参数与readback | C3；示例及命令字段转接，无新自动重试语义 |
| 12 logs/config | 独立日志worker、credential-state及共享任务日志 | W5,H4,Z4；凭据不入DB，日志删除不删审计，不扩建日志模型 |
| 13 DB/cache | `@db` strict runtime、db/client setup、三个进程连接owner、snapshot/cache | T01,H4,C4,Z2；初始化与runtime分离、只读失败不fallback，cache依赖含新assignment修订 |
| 14 compatibility/ops | 两namespace aliases、历史hash/audit/receipt、备份/回滚、最终物理schema | T02,H1,H2,Z1–Z4；旧表词汇仅upgrade/test，原FAIL不抹除 |
| 新增直接owner | decision-lifecycle-102、evidence-impact-113、review114、recognized-filter-source、scope/error索引 | W4,R5,H2；各自旧谓词保持，不能统一effectiveTitle |
| 新增动态owner | Nitro rollup三个entry、source loader、job registry、生成路由与MCP自动发现 | H4,C3,Z2；源图和packaged图都覆盖，lexer不作为完整证明 |
| 新增性能owner | query.ts、district/annual/statistics-effective-snapshot、filter-options与三源aggregates | Q1–Q6；F01由T01/R4解决页输入，F09 comparison已用orderBy且全局counts保持，新增分页语义另议；F12测试helper不称生产瓶颈 |

## 补读结果与剩余阻塞

本轮对关键 owner 作静态补读，原研究的1,131文件lexer、101直接hit、543反向闭包计数不升级为语义完成。Git外 `a0/READS.tsv` 记录本轮范围和指针，`a0/issue-706.json`、`issue-707.json` 为实时票面。其余原研究文件保留未审状态。没有运行Nuxt或访问DB。

| 已定位入口 | 静态发现、责任与处置 |
|---|---|
| `roster-import.ts:3188-3268,4270-4285` | writePlatformQuery是真正双写点；归属merge直接改relation；W1–W4替换事务内owner，不能只改live-query |
| `platform-live-query.ts`、`platform-batch-query.ts:1-127` | live返回结果，batch.result持segments和unfinished；W5保留accepted页、限额、凭据内存及显式重试位置 |
| `platform-business-record.ts` | raw TEXT用于fingerprint、同hash仍比较canonical bytes、recognized additive fidelity、完成检查重读源；T03/W1–W4保持这些验证而移除旧SQL |
| `decision-lifecycle-102.ts:202-227` | confirmed、owner、query-only企业绑定和多title页判断；H2按原规则读typed facts，不能借candidate较宽scope通过 |
| `comparison-scope-proof-source.ts` | 整query与queryRows进入fingerprint，连续页/末页及freeze文件独立验证；H2必须独立重现旧envelope，不能只迁ID |
| `evidence-impact-113.ts:120-175,282-295` | partition/coverage/fact digest依赖页、条件、归属和原query；W4捕获新变化，H2保留旧revision与review授权；其余处理循环未作逐分支正确性保证 |
| `record-correspondence-read.ts:66-114`、`event-annual-process-read.ts:263-451` | query metadata裁剪与relation row绑定；年度潜在query/同业务历史/protected closure全需转接，H1/H3负责 |
| `import-execution-worker.ts`、`current-export-worker.ts`、`enterprise-read-worker.ts:77-141` | 首个校验dev/ino/schema/migration；导出只读连接；企业读检查owner并在整reader transaction内处理；H4不得自动迁移或回退 |
| `*-worker-location.ts`、`import-execution-source-loader.mjs`、`nuxt.config.ts:368-440` | source jiti loader与Nitro emitted relocatable chunk是两套实际entry；H4/Z2均需packaged图验收，不能仅rg server入口 |
| `job-specs.ts`、`job-runner.ts`相关注册/params/checkpoint符号、`job-store.ts` | registry包含batch、candidate、annual、export、OCR/reconcile/render；H4必须逐kind盘点serialized refs，不改历史payload/hash |
| `roster-import-platform-schema.ts`、`query_platform.ts`、`platform/query.post.ts` | import枚举来自将删除的schema；实时HTTP/MCP共同runPlatformLiveQuery且只读，C3迁枚举领域owner并保留错误契约 |
| `evidence-review-114.ts:1-195` | list持有最多64个120秒WAL只读snapshot，cursor绑定filter/anchor及HMAC；get通过readQueryCoverage间接读query；H2切换前排空snapshot，过期cursor仍要求重读，保留receipt与decision lineage，不替换merged旧decision |
| `jobs/candidate-discovery.ts:1-110`及continuation符号 | queryId限制affectedWhere，result含event/page/rowIndex，续任务clientRequestId含queryId和archiveGeneration；H3/H4按旧namespace解析，不能改key后沿用request hash，source budget查relation也须转typed owner |
| `stored-files.ts:355-393,657-737`、`evidence-read.ts` | 文件设施不保证不可变历史blob；证据接口原字节切片与computed relation DTO须分别验证，T02选SQLite archive |

明确阻塞属于后续票，不能默认为安全：H4 启动写切换前须完整列举每个 job kind 的 params/result/checkpoint 的所有 ref 及原hash入口，补读 annual/candidate/import receipts 中未全读分支。H3 须完成年度闭包全分支，H2 须完成113/114全命令，C3须枚举所有served HTTP/MCP及skill客户端，Z2须解析Nuxt自动导入、生成路由、worker emitted依赖、Python/shell运维入口和非字面SQL。T01无这些运行前置，但Z1不得带未指派owner或未解释词法hit接受。这是明确的交付阻塞清单，不是额外无界研究票。

## ORM 证据和例外

只读检查本机 `/Users/mang/.t3/worktrees/app/t3-0f0976cd/node_modules/drizzle-orm/`，package.json:3 为0.45.4；当前pnpm lock同版本。没有安装依赖、修改该checkout或运行类型检查。

| 能力 | 已读取类型依据 | 结论与owner |
|---|---|---|
| CTE、distinct | sqlite-core/db.d.ts:50-165 | $with/with/selectDistinct可用；普通来源options无已证ORM限制 |
| groupBy、limit/offset、union | sqlite-core/query-builders/select.d.ts 的 groupBy 签名、428/445、491/517 | 用typed builder构建聚合与候选union；API存在不证明plan更优 |
| 同步事务、模式 | better-sqlite3/session.d.ts:28-32；sqlite-core/session.d.ts:52 | 同步callback，behavior支持deferred/immediate/exclusive；业务不可在事务中await网络 |
| BLOB buffer | sqlite-core/columns/blob.d.ts:45-71 | archive用buffer mode，不用JSON mode |
| UTF-8原字节切片 | lib/platform/evidence-read.ts:48-58 | SQL cast/substr/length为必要SQLite表达式；Drizzle sql模板保留，不是整段raw SELECT例外 |
| PRAGMA、FK重建、sqlite_schema、备份 | db/client.ts及worker的pragma；升级专属工具 | 基础设施SQL例外，逐操作限定，不扩散到业务服务 |
| JSON5二阶段提取 | db/migrations/0027与current scope规则 | upgrade-only冻结旧oracle；新写在入库边界显式提取；不得保留runtime archive JSON fallback |

没有获准的“复杂CTE所以ORM不支持”、MATERIALIZED或INDEXED BY运行例外。本轮未做EXPLAIN，Q票须给实际API限制和隔离query plan再决策。新原生SQL需附表登记路径、原因、builder无法表达的具体API、独立oracle及删除条件。

## 文档检查与执行证据

本轮可执行检查限 Git diff --check、Markdown本地路径存在性、依赖图节点/环与14组覆盖静态核对、docs-only diff，以及合并最新本地integration后 clean SHA/tree。记录在仓外 `a0/DOC-CHECKS.txt`。这些不是独立审核，也不是运行验证。所有数据库、迁移、build、测试、性能、HTTP/MCP、浏览器、工作簿和生产执行均UNRUN。历史B409、705性能FAIL保留；#691/#702为接受的继承结果，本轮未重跑。

#714 is the bounded schema prerequisite for T05/#713, not historical transfer acceptance. [Uncaptured indexing](t05-prerequisite.md) defines the paired not_indexed branch, unchanged indexed-writer default, six incoming FK owners and populated 0051 rollback oracle. T05b source extraction and T05c final PK/FK promotion remain separate.

## T05b upgrade-only SQL infrastructure

`upgrade/projections.ts` uses native SQLite only for schema/PK discovery, all-cell storage/byte manifests, original archive metadata snapshots, canonical_raw_json CAST bytes and integrity/FK PRAGMAs. Drizzle cannot represent dynamic sqlite_schema/PRAGMA column inventories or SQLite storage-class byte manifests as ordinary typed entities. The independent full-PK/cell, literal field, archive metadata, rollback and subprocess oracles are in platform-projection-upgrade.test.ts. Ordinary projection/version/ref/run/checkpoint CRUD and source-specific joins use typed Drizzle. These upgrade-only inventories cease to be used after offline retirement acceptance; they are not a business mixed helper or runtime fallback. See [T05b operation and boundaries](t05b-projections.md). No schema delta; T05c final FKs remain separate.

## T05c offline finalization seam

See [T05c operation and phase boundary](t05c-finalization.md). `upgrade/finalize-observations.ts` uses the accepted catalog/PRAGMA/byte-manifest infrastructure exception for same-name populated DDL, explicit column copies and sqlite_sequence watermarks, with independent literal/SQLite-cell/rollback oracles. It is not a registered startup migration. Shared Drizzle builders keep expand registration unchanged; target declarations and archive resolver are offline only. Version refusal is the only runtime behavior change (db/client and three worker open boundaries); W/R/H/C/Z still own actual cutover and final cleanup. H1 references, scope/error transition and canonical inline writer dependencies explicitly remain.

## W1a explicit apply transaction seam

[W1a writer boundary](w1a-apply-writer.md) implements apply-only writes into an explicitly supplied finalized-target transaction and existing collection. Target declarations/archive resolution and pure source extraction now have shared `lib/platform` owners; upgrade paths re-export/use them. Current runtime finalized-target refusal stays in place. Public import/collection/page/scope creation, receipts/113 and deletion of the legacy apply branch remain W1b/W4; no public API switch or full W1 acceptance is claimed.
