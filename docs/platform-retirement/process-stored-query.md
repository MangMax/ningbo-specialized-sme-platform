# #734：关联办理精确原列捕获与显式目标读取

状态：父级已 fresh 独立接受 A1/A2（含 BOM、optionalString key 和 private scratch 窄修），本地集成为 `90290c79c2ae23e6b93c92bacc4391ef01a8e9e1` / tree `2e39fea6c93037671885efa877590ab84e874d54`。**B 是待 fresh 独立接受的显式 process ORM reader 候选**。不新开前置票，不改公开接线或 global guard。

固定基线 `5c3aa8757fc8d8c4c20e885ab2a4d256eeed3adb`，tree `072ca65c626d7b247740f74c7ff2ed8681742230`。`0790e121` 仅为完整迁移缺口诊断。当前旧接口源码是 [process reader](../../server/utils/platform-business-processes.ts)、[options](../../server/utils/platform-filter-options.ts)、[旧 SQL 原行](../../server/utils/platform-legacy-relation-read.ts)、[原写入](../../server/utils/roster-import.ts)。复用现有 [target schema](../../lib/platform/target-schema.ts)、[source extraction](../../lib/platform/source-extraction.ts)、assignment、alias 与 archive owner，不新造业务表、通用模型或新的归档 owner。

## 原列、查询和可用事实

下表的“exact”在显式71610候选schema中提供，不是公开接口。八列只能在 `platform_business_projection` 的 observation-owner 保存；version-owner 的全部新增字段必须 SQL NULL。

| 原 SQLite cell / affinity | 待捕获字段 | 旧 consumer 和语义 | 不可替代它的现有字段 |
|---|---|---|---|
| title_raw / TEXT | exact_title_raw | isolated DTO、精确 titleRaw filter、isolated titles options | sourceTitle* 是原 JSON rdjb；version.titleRaw 是 parser 结果 |
| declare_kind / TEXT | exact_declare_kind | isolated DTO/options 原拼写；filter 仅归一化输入后对原列精确相等 | storedDeclareKind 已字典归一化，申请/apply 合并 |
| year / INTEGER | exact_year | isolated businessYear DTO；year filter 原列相等；全局 years options 先 DISTINCT/DESC 再 JS positive safe integer | businessYear 是版本原文年；storedYear 是 comparison 输入，不是所有原 storage class 的表示保证 |
| status / TEXT | exact_status | isolated DTO、status filter、statuses options | storedStatus、parsedStatus、reconciledStatus 各有 trim/conflict 语义 |
| batch / TEXT | exact_batch | isolated DTO、batch filter、batches options；whpc 独立维护批次 | storedBatch/parsedBatch/reconciledBatch，不能补 personuuid/year |
| applied_at / TEXT | exact_applied_at | isolated DTO；无新增日期筛选 | storedAppliedAt 已 trim；版本日期排序仍读 version projection |
| award_batch_label / TEXT | exact_award_batch_label | isolated awardBatchLabel DTO；personuuid 是原认定批次标签 | storedAwardBatchLabel 已 trim；不是业务年、人员 UUID 或 whpc |
| province / TEXT | exact_province | isolated DTO；无新增属地筛选 | storedProvince 已 trim；normalized/conflict 语义独立 |

八列独立于正常版本、stored comparison、parsed、reconciled、conflict 列，后者的值、类型、rule、时间、缺值语义和 hash 均不改变。真实 NULL、空串、空白、false 经旧 SQLite affinity 后的结果不能互相替代。原 schema 非 STRICT；不能给 exact 列加 text-only/integer-only CHECK，驱动类型应为 unknown，不伪装成 DTO 声称所有历史类型均支持。

**复用而不重复存储**：isolated nameRaw/usccRaw 来自原 assignment revision1，sourceRelationKey 来自 observation，query/relation 外部 ID 来自原 alias，元数据来自 collection，scope 来自 collection + scope index。捕获/认证必须逐 owner 验 revision1、source key、alias、collection/sequence 与可信来源相符。revision2+ 的正常更正不覆盖 revision1/exact 原值。不能拿当前归属推断历史输入。

records/detail 的内容字段仍用 version-owner process projection。记录层企业筛选是该记录任一观察，rdjb 是匹配版本对应观察的查询 CSV/index；同 version 的全部字段谓词必须同时成立。全记录 counts、原 appliedAt/null/versionId 代表版本排序、全局 options、详情100/200边界都留 B 独立证明；A 不改这些规则。

## 独立 SQL fact-title：必须捕获

旧 facts 的 `titleRaw` 是 `legacyRowTitle(legacyRawRdjb)`，后者直接执行原 SQLite `json_valid → json_type($.rdjb)='text' → json_extract`，随后 ECMAScript trim。新字段 `sql_fact_title` 及其 capture metadata 归 process observation-owner。它不是 exact_title_raw，也不是 sourceTitle 或 version.titleRaw。

实测 literal：原文本 `{"rdjb":"2","rdjb":"3"}`，原 stored title 改为 `X`，旧 SQL fact-title=`2`，JSON.parse/source title=`3`。首键非 text 后键 text 得 SQL NULL/source3；反序、转义键名 `rd\u006ab` 混用也保留 SQL 首键。顶层数组、无键、NULL、非法 JSON、number/boolean/object/array 都不给 text title；空白字符串 trim 后为空则 NULL。

捕获只能在固定快照离线、新写入或有界原输入认证执行旧 SQL 语法，输入必须是实际原 SQLite raw_fields 或同 owner sealed rawFields 的原字节及 storage class，不重新序列化 JSON.parse 结果。B 的业务筛选/计数/分页/facts 直接读结构字段，不解析 archive JSON/v8。

## 已实测矩阵及明确限制

测试 [platform-process-stored-734-matrix.test.ts](../../tests/platform-process-stored-734-matrix.test.ts) 使用真实旧 schema、独立旧服务和 literal，不调用未来 process extractor 生成唯一期待。

| 输入/分支 | 实测结果 |
|---|---|
| 八列分别 SQL NULL、空串、单空格、带空白文本 | 原 affinity 后 typeof/hex 按 literal 保留；NULL 与空白不是 uncaptured |
| SQL 2024、'2024'、2024.0 | year 都 INTEGER2024；TEXT 列前两者为字符串2024，REAL literal2024.0 在 TEXT 列为字符串2024.0 |
| SQL REAL2024.5 | year 为 REAL，hex323032342E35、real64be409fa20000000000；旧 isolated 返回2024.5 |
| year TEXT bad、BLOB2024/零长度BLOB、0/-1 | 原类型/字节保留；旧 options years 仅[2024]；year=2024命中三种被 INTEGER affinity 同化的输入，不命中BLOB/REAL2024.5 |
| 内嵌NUL TEXT、非法UTF8 TEXT FF | 原SQLite hex保留；普通驱动解码不能证明字节可逆，successor 必须独立校验/拒绝，不能String化修好 |
| INTEGER9007199254740993 | 原SQLite整数hex仍准确；旧默认driver DTO已变为9007199254740992，不能把近似输出当原cell；需要safe整数/字节认证，不假称新capture已支持 |
| 18种原raw JSON/NULL事实 | 旧SQL与JSON.parse分别对literal断言；上述重复键证明独立fact-title必需 |
| 历史REAL-year完整迁移 | 使用实际 candidateFixture 完整链入口，T05b sourceFieldComparison 报 `Unrepresentable legacy process year`；该历史拒绝保持，**未修改T05b，也不宣称完整链已支持REAL** |

这里证明旧表示与既有拒绝边界，不证明未来 target capture 的所有类型都可认证。尤其 not_indexed、旧 bootstrap、无 snapshot、非法 UTF8、unsafe integer、非数 year、各 capture-origin 和迁移事务恢复，须按下面 A1/A2 各自证明；不能用这三个 oracle 测试替代实现验收。

## 捕获状态、来源与生命周期契约

1. exact 分支保存八原cell + `exact_stored_state/rule/origin/reason`。规则拟 `process-stored-cells-v1`；origin 限可信 `legacy_source/sealed_snapshot/command_materialized`。captured 的 origin/rule 必填、reason=NULL，八列允许真实全NULL；uncaptured 的八列/rule/origin 全NULL、reason非空。每条观察必须有状态，不以 inner join 丢掉未捕获者。
2. fact-title 分支保存 `sql_fact_title/state/rule/reason`，规则拟 `process-legacy-sql-fact-title-v1`。captured 值限TEXT/NULL、rule必填/reason=NULL；uncaptured 值/rule=NULL且reason非空。它与 exact 同 owner 但独立认证，不能用一个 captured 状态掩盖另一个分支未捕获。
3. source binding 复用同 owner sealed legacyRowSnapshot/rawFields、原 fingerprint basis、aliases 和 successor 对冻结 source 的 hash/manifest 绑定；不增加 archive owner，不拿目标残留旧表自证。固定旧源与封存 snapshot 同时存在而矛盾则事务拒绝，不任意选一方。归档长度/hash/seal、字段 inventory、坐标、revision1/key、原规则均必须验证。
4. legacy-indexed/legacy-bootstrap 按原输入生命周期认证；not_indexed 不伪造原 fingerprint。无可信cell或无法在旧verifier表示的类型保留uncaptured和原档，并明确 queryReady=false。矛盾来源/映射/字节漂移是拒绝，不降级成可读NULL。
5. target-command-v1 只从认证的原 canonical envelope 和实际 rawFields serialized bytes 重建原写入物化。`normalizePlatformRelation('business_list', originalRow)` 后 optionalString trim/非string→NULL，year 为有限number Math.trunc，否则NULL；title按旧0043写列语法，fact-title按旧facts语法。保留原 own-key/omit/null、position、assignment 和 fingerprint bytes，不能给hash envelope加exact字段。新writer必须核rev1 name/uscc和key与实际物化相符，冲突拒绝不覆盖。
6. 捕获仅首次 INSERT。UPDATE、UPDATE OR REPLACE、INSERT OR REPLACE、upsert、DELETE重插、跨owner覆盖都不能绕过不可变和原配对；正常同owner重放只认证不改值。不能仅靠projection INSERT trigger，因为完全遗漏projection不触发；沿apply模式用观察内部引用和延迟复合FK约束两个captured状态，最外层COMMIT闭合。新process观察必须captured配对；历史uncaptured配实际状态。其它source配对必须NULL。这些是内部引用，不是通用业务字段。
7. successor 在FK-ON固定快照/独立target的immediate事务中完成DDL、原cell复制、屏障、完整manifest、回执。捕获触发器、incoming FK owners、sqlite_sequence高水位、原归档与旧run/hash/receipt/checkpoint字节全部保留；失败连DDL和回执一起回滚。外层caller catch/savepoint不能留下半捕获状态。旧writer在新catalog缺exact提交必须拒绝。
8. 原predecessor verifier在加列前认证并冻结结果；successor的catalog检查必须真实绑定新增列/约束/trigger/FK和完成receipt，不可仅认phase/rowcount，不可重写旧receipt迎合新schemaHash。恢复补证据用新的显式离线successor，不UPDATE已有capture或复用旧run。正常runtime/三个worker的非零phase拒绝继续保持。
9. ordinary replay保留既有legacy-bootstrap流程，reference不bootstrap；均先typed owner坐标选择，再认证原来源/规则/归档/映射及exact八cell和fact-title。exact缺失不借replay修复。后续revision正常可见，原输入仍对revision1认证；篡改一cell也必须拒绝，不能只看input hash。原legacy source conflict错误/normalize比较不全局改成exact。

## A 实际超 M：已获父级确认的最窄同票分割

不是另起前置链，也不是重复架构调查。A 同时包含两个已有同类独立接受单元：apply S 的 populated DDL/offline 与 W 的运行物化/replay。这里实际还要保持已接受 R3/R5 catalog successor 链，不能把它们折叠进“加八列”的提交。具体接缝见下表；A1 已获实施授权，不将 A2/B 未实现部分称PASS。

| 同票单元 | 最窄代码/事务owner | 独立验收与出界限制 |
|---|---|---|
| A1 ≤M，高难度：schema/固定快照转移/屏障 | process-only stored schema/cells/offline schema+transfer；db/schema-phase显式successor注册；仅必要的target projection声明；process catalog完成绑定；现有recognized-stored/witness catalog对新successor的明确predecessor hash解包，不放宽旧catalog；有界可信旧源/封存snapshot/原command恢复所需纯物化 | 八cell+独立fact-title全矩阵、原源完整链（REAL保持reject）、snapshot/映射冲突、旧run/manifest/receipt不变、FK-OFF零写、遗漏projection/REPLACE/upsert/DELETE/跨owner/outerCOMMIT拒绝、populated DDL多阶段回滚、恢复/重跑绑定、uncaptured清单；旧runtime guard仍拒绝，process新writer在A2前明确停用。只接这个schema/offline seam，不实现新写或replay切换 |
| A2 ≤M，高难度：新writer及认证 | process-target-writer、纯materialization、fingerprint-verifier的process精确白名单+独立cell认证、collection-target-command/replay的process分支、scratch catalog继承和capture phase明确允许已认证successor | direct writer/完整command/ordinary/reference，原bytes/hash不变，真实8cell物化，rev1/rev2、same raw不同stored input、单cell drift、source-rule/alias/assignment漂移、caller-caught rollback、safe-ID耗尽、FK-OFF和deferred COMMIT；其它source原行为不变。不能跳过整个extra-field认证，不能重审/重写已接受R1/R3/R5业务实现 |

A1→独立接受→A2→独立接受，二者共同构成 A；然后才允许 B。A1开工基线5c3aa875时核定71610；A2开工已合最新LOCALintegration efc26f3f，不另造worktree。A1不接受未知schema或改写旧receipt；A2只为经认证的该显式successor接入内部写入/认证，不授权旧binary或公开入口运行。

## A1 候选的调用、catalog 与 A2 接缝

显式入口 [finalizeProcessStored](../../upgrade/process-stored.ts) 只接受完整71609 + 已接受 recognized-stored/witness catalog 链。先由原predecessor verifier认证可信来源；随后在FK-ON immediate事务重建固定incoming owner图、转移原cell并核逐cell可逆、安装屏障、比较全部原数据/sequence/旧receipt manifest，再写唯一successor receipt/checkpoint。移植保留原ordinal顺序，字段inventory按完整唯一名称集合认证，不能拿Drizzle声明序替代旧ALTER后的列序。失败连DDL一同回滚。source-only恢复必须通过原receipt绑定的legacy custody；目标残留旧业务表不作源事实依据。

Node24.22.2下可离线调用（SOURCE必须是停写后已有工具取得的固定独立快照，TARGET为其独立副本；不对活库提供写排除保证）：

```sh
JITI_FS_CACHE=false node upgrade/run-process-stored.mjs SOURCE_71609 TARGET EXCLUSIVE_EVIDENCE RUN_ID WITNESS_PREDECESSOR_RUN_ID [FROZEN_LEGACY_SOURCE]
```

证据目录必须尚不存在；CLI保留source/before/target或failure的完整cell manifest、catalog/FK及来源指针。`queryReady=false`与逐owner recovery原因清单是合法诊断产物，不是reader可用。缺值不由重放修复。固定源/原legacy变更、target数据或checkpoint漂移均拒绝原run重放；正常同owner重复执行保持原捕获不变。正常首次schema配对允许提交；新写入的真实input认证留A2。

[processStoredInstalled](../../lib/platform/process-stored-catalog.ts)核明确列/trigger/延迟配对形状、实际target schema hash、唯一完成receipt/checkpoint及原witness receipt指向；source阶段同时调用已接受R3/R5实际catalog认证。原R3/R5和fingerprint运行gate仍按其原phase拒绝71610，不放宽、不重写旧receipt。A2才为显式71610添加经过认证的predecessor解包、scratch继承和process白名单cell认证；A1的installed gate只证明catalog完成，不认证任意新command或使旧reader可运行。

上述拒绝是 A1 交付时的运行边界。A2 候选通过 `processPredecessorSchema` 解包这一份实际完成的71610回执到原71609 schema hash，再由既有 witness/recognized gate验证原链，不改写任何旧receipt。未知schema、缺回执/屏障和漂移仍拒绝。private scratch仅能从已认证源继承到同catalog的空内存库：所有非SQLite内部表必须无行，唯一例外是query/relation两个值为0的alias highwater初始化行；并固定完整catalog hash；继承后再增列也拒绝。旧phase路径保留，不引入环境selector或通用schema例外。

新process观察配对需先有revision1和target-command basis；沿既有apply策略，低层首次插入实验在事务中用`defer_foreign_keys=ON`容纳原immediate assignment FK，但始终保持`foreign_keys=ON`。物理process复合FK为DEFERRABLE INITIALLY DEFERRED。遗漏整个projection/任一captured分支可RELEASE savepoint而不能outer COMMIT；失败后由caller回滚。捕获冻结同时拦截INSERT/UPDATE OR REPLACE目标、upsert、DELETE和跨owner移动；oldwriter即便在受控实验中降phase绕过JS，SQL屏障也拒绝缺capture提交。globalguard、三个worker拒绝不变。

既有target-command恢复仅在离线原来源认证后物化8cell。例如输入空白pending实际旧写得pending；raw year `2e3`在原process normalization可得2000，而版本parser仍保持NULL。旧comparison/version列不因此改写。legacy-indexed、已证明legacy-bootstrap、not_indexed、command、source-only和snapshot-only都按各自来源处理；不凭当前归属/请求猜生命周期。历史REAL-year完整链仍按T05b拒绝；下层schema表示REAL并不证明能绕过该拒绝迁移。

## A2 显式写入与源认证候选

`process-target-writer` 在同savepoint内先捕获原canonical envelope/basis，按旧真实物化规则计算8cells，核原revision1 name/uscc与物化相符，绑定trim后的source key，成对写captured observation/projection。其余比较/version/hash字段仍用原输入及原parser，不能把normalized clone交给原hash函数。omit/null/position own keys、raw/sourceText字节和输入hash独立保留；同一raw版本可有不同stored input/观察。首次写入与重复输入认证都保留FK-ON；按原apply策略延期原assignment FK，caller catch不留下半组owner。

`verifyProcessStored` 只认证选定owner：先验证state/rule/origin/pair、sealed raw hash/length/class，再按原command物化或原sealed snapshot的8个SQLite cells比对typeof/bytes/REAL表示，单独认证SQL fact-title、revision1/key和version-owner全NULL边界。fingerprint verifier仅对白名单16capture字段转交该独立认证，原其它字段/映射/来源检查继续执行；普通command scratch仍比对整个原projection。rev2更正不回改rev1/input。历史uncaptured、缺projection或任何cell/source/rule/alias/rev1漂移拒绝，不借replay补值。

ordinary/reference仍先按typed坐标选观察，再按原来源比对和上述认证；reference不bootstrap，ordinary只走原legacy-bootstrap生命周期。process71610的两个实际BOM反例已固定测试：SQL title仍按BOM-preserving严格解码得到NULL；snapshot用于canonical输入断言时按既有fingerprint decoder解析，避免与archive canonical语义误冲突。plain sourceText在本source认证读取中保留BOM/NUL原文本。它们都是限定于process71610的源认证适配，不改变全局canonical/fingerprint decoder、serializer或其它来源语义。

对三来源的显式successor写入需要保留同一已认证catalog链：apply继续其exact分支，recognized继续其原collectionEvidence/SQLtitle/witness认证，不转用process字段。global runtime/init/worker非零guard仍拒绝；没有HTTP/MCP/worker公开切换。A2交付时不含B reader。原A1“旧writer拒绝”测试在其历史SHA保持，A2将当前断言改为“认证writer可写captured，降级marker的未捕获旧路径仍受SQL屏障拒绝”。

A2新增精确测试映射、所有firstFAIL、实际逐cell漂移/回滚/私有catalog/跨来源矩阵及fresh/inherited/UNRUN证据位于仓外 `r2a/capture/a2/`。A2候选不等于A总项、B、完整R2或生产接受；fullaffected145、REAL-year历史拒绝状态不变。

A1/A2都不做reader、公开HTTP/MCP/worker切换、global guard解除、H3/H/C/X、物理删表、生产/真实DB/Docker/fullbuild/UI或性能压测。fullaffected145历史UNRUN不被本轮新测试数覆盖。

## B ≤M：显式 process ORM reader 候选

[platform-business-processes-target.ts](../../server/utils/platform-business-processes-target.ts) 提供 `listTargetBusinessProcesses`、`getTargetBusinessProcess`、`readTargetBusinessProcessOptions` 和 `readTargetBusinessProcessFacts`。没有 environment selector、公开接线或新 schema。事务中先核71610实际catalog及全域process观察的capture/assignment/revision1/aliases，之后才筛选、计数和分页；缺capture不因空结果、深页或INNER JOIN被丢掉。真实NULL可读。isolated的8个原SQLite cell在显式边界保留unknown类型，不把BLOB/REAL假称为string/integer；years options仍只接受JS positive safe integer。

| B字段/行为 | 实际读取owner与分支 |
|---|---|
| records/detail版本、事项/业务年/personuuid/whpc | version-owner process projection；同version谓词。personuuid→awardBatchLabel，whpc→batch，二者不推断year |
| isolated DTO/filter/options | observation-owner exact8cells；declareKind仅归一化输入，SQL比较原列。SQLite trim/BINARY/DISTINCT排序保留 |
| facts title / stored / display | sqlFactTitle独立字段；typed版本、逐观察stored/parsed/reconciled/conflict各自读取，`withArchiveProcessFacts`保持原补值/冲突规则，无JSON/v8读取 |
| 原名/归属 | isolated和untyped facts用assignment revision1；过滤/列表企业/详情用最高revision，整次请求同snapshot，下次请求见新revision |
| scope | filter是原未trim CSV membership OR index；display是CSV split/trim与index的ordered union。rdjb EXISTS限制匹配version，企业EXISTS仍限制整个record |
| counts/order/hydration | whole-record版本/观察计数和activity；代表版本按appliedAt NULL-last、日期DESC、version ID DESC；数据库分页后仅水合选页record，详情limit100/200；facts按400个外部alias分批 |
| 对应关系与ID | query/relation外部alias；correspondence只按选定具体观察的relation alias，不能复制给同version其它观察 |

[platform-process-target-734.test.ts](../../tests/platform-process-target-734.test.ts) 从独立旧schema实际通过全部已接受迁移到71610，使用旧service与literal对照完整DTO、options、filter/count/order、normalization冲突、SQL重复键/BOM、raw-only/not_indexed、缺version projection、capture拒绝、snapshot freshness、实际截断和SQL trace/EXPLAIN。独立未索引旧行原先不在旧observation查询结果内，目标迁移生成not_indexed后以literal验证；不把二者伪称完全等价。历史REAL-year完整迁移仍T05b rejected，表示层矩阵不等于完整链支持。

精确旧consumer接缝仍保留：`server/api/platform/business-processes.get.ts` / `[recordId].get.ts`，MCP `list_platform_business_processes` / `get_platform_business_process`，`server/api/platform/filter-options.get.ts` 的business-processes分支，以及`platform-source-facts.ts`的business_list分派。后者仍供business-detail、record-correspondence-candidates、event-annual-process-read和comparison-platform使用。页面仍调用旧HTTP。只有这些消费者分别完成所属接线后，才能删除旧process服务及options分支；`platform-business-read`的legacy assignment/scope/enterprise helper和`platform-legacy-relation-read`还有其它source消费者，不能在B删除。H3/H/C/X与公开切换由各自owner处理。

B仓外交付证据为 `r2a/reader/implementation/{REPORT.md,HANDOFF.md,VALIDATION.json}`，保留原`r2a/reader/REPORT.md`诊断。fresh、inherited、FAIL、UNRUN分别列出；合latest LOCALintegration后以clean SHA/tree重验，交父fresh merger，不自行合入integration或启动后继。

仓外证据 `/Users/mang/.t3/acceptance/platform-complete-migration/r2a/capture/`；原诊断 `/r2a/reader/` 保持。first-red同时保留了误假定TEXT列2024.0会变为2024的断言失败，以及SQL首键与JSON末键确实不等的RED；后续修正期待不抹掉它。各小批自有synthetic逐成员路径/type/mode/length/SHA256/link验证归档后释放，保留restore manifest。没有安装依赖、改共享缓存、子代理、远端写、primary写或业务卷操作。


## R2b #735：关联办理 handler 集成

HTTP `business-processes` list/detail、MCP `list_platform_business_processes` / `get_platform_business_process` 和 filter-options 的 business-processes 分支接入上述显式 target reader。沿用原输入 schema、HTTP 参数转换、错误映射和 no-store，不新增 selector/fallback，不改变全局启动及 worker 非零 phase 拒绝。页面继续调用相同 URL；这是集成候选，不能提前部署或视作生产启用。

[handler 测试](../../tests/platform-process-target-http-735.test.ts) 在测试专用 DB 注入下，从真实合成旧源经完整已接受迁移到71610，运行实际 H3 HTTP 与 MCP handler；数据不使用服务返回值 mock。旧 service 和 literal 独立对照 DTO、records/isolated、筛选、分页、全局 options、错误、截断、8cell 原类型及 W 新写/ordinary/reference replay 后读取。SDK transport 未执行，保持 UNRUN。

剩余旧路径：`platform-source-facts.ts` 的 business_list 分派仍调用 `readPlatformBusinessProcessFacts`；其消费者 `platform-business-detail-read.ts`、`record-correspondence-candidates.ts`、`event-annual-process-read.ts`、`lib/comparison-platform.ts` 由 H/C/H3 等 owner 负责。`platform-filter-options.ts` 的旧 business-processes 分支继续保留为旧服务契约，公开 handler 已接 target。`platform-business-read.ts` 的 assignment/scope/enterprise helper 和 `platform-legacy-relation-read.ts` 仍有其他来源消费者，不删除共享模块。recognized handler、worker、导出及全局切换不属本票。完整 W/R/H/C/X 闭合与最终切换验证之前仍禁止生产启用。历史 fullaffected145 UNRUN、REAL-year T05b rejected 与 B409/HTTP/filter-options 证据不改判。交接与新鲜证据在仓外 `r2b/{REPORT.md,HANDOFF.md,VALIDATION.json}`，由父级独立 merger 接受。
