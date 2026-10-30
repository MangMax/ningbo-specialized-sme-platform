# 平台同步解释：纯核心与显式读取

`lib/roster/platform-comparison.ts` 提供同步纯函数
`comparePlatformComparison(input: CandidateComparisonInput): PlatformComparison`。
新投影版本为 `platform-comparison-410-v1`。它解释已经归一的来源见证，
不生成正式资格、不写人工差异原因、对应决定或审计。

既有 reader 的 #427 显式比较方法由 #428 接入同 snapshot 年度流程、当前对应与业务版本见证，支持完整零记录及 P/N 分支。
HTTP/MCP、列表、筛选、详情和工作簿未启用比较投影。
默认 `enterprise-qualification-407-v1`、current/export 及旧 snapshot/hash 不变。
#428 已完成限定可信装配与编译产物验收；#410 公开消费仍为后继，未新增公开比较入口。

## 输入与可信装配

输入类型直接引用既有 T2、CycleJudgment、query metadata、annual 和当前对应 refs，
服务端引用全部为 `import type`。运行时仅导入 `node:crypto` 与既有纯 `buildAnnualProcess`。
函数不读取 DB、文件、网络、环境变量或系统当前时间，也不修改输入或全局状态。
测试中的合成 fixture 只使用内存值，没有业务库或来源文件读取。

| 字段 | 协议 |
| --- | --- |
| `version` | 固定 `platform-comparison-410-v1` |
| `legacy` | 完整既有 CurrentQualificationSnapshot，保留原 scope、titles 与 snapshotId |
| `titleCode` | 仅选择 legacy 中唯一同称号 assessment |
| `formal.assessment` | 同一 legacy assessment 的窄 Pick，逐字段一致；不能覆盖正式 group |
| `formal.cycles` | 既有 authority 选中的当前周期、CycleJudgment 窄 Pick、eventIds 连接 |
| `queries` | 完整来源数组与 truncated；每项为 QueryCoverageSource、实际 queryKey、可空窄 metadata |
| `processes` | 完整已归一 AnnualProcessInput、sourceRefs/sourceGeneration、当前及保护决定 refs、可空 finalQualification |

正式周期是 `{originYear,batchSeq,precision:'year'}`。连接检查锚点与正式 evidence 的
事件类型、原年、原批、结论年和结论；事件 revision、evidence IDs、来源 hash 同时绑定。
平台 year、whpc 后缀不能补原周期。未知批次保持 null，不填 0。
正式组、主体终止、地域与资格规则仍来自既有 authority。

legacy snapshotId 独立沿旧协议校验：SHA256(JSON.stringify([旧 scope,titles]))，
旧 scope 字段插入顺序为 enterpriseId、asOf、ruleVersion、assessmentVersion。
不能用新的 canonical 摘要替代旧校验。形式错误抛固定错误码，
例如 invalid_json_input、invalid_legacy_snapshot、invalid_selected_assessment、
invalid_cycle_join；业务证据不足则返回 not_established。

类型并非来源认证。本接口不是接收任意用户布尔值的公开入口；未来 adapter 必须在同一
只读 snapshot 内装配、重新核对当前 validity，并证明 annual scope 完整。
不得传显示分页 steps、旧任务 DONE、eligible=true 或 confirmed=true 替代完整见证。
仅有当前 T2 的 status/year/batch 瘦行不足装配 P/N。

## Query、annual 与时间

metadata 只包含 source/status/effectiveConditions/titleScope/pages/completeness/
fullRange/unfinished/error/limits，不包含 rows/rawData/raw_response/rawFields。
核心核对 metadata 和 QueryCoverageSource 的条件、页、状态及范围一致，
不直接相信 outcome 或旧聚合 coverage.status。全范围完成证明要求从 page 1 连续读取，
页状态成功、计数合法、总数或末页证明闭合；pages 不会被自动修复或重排。
原生 apply_list/queryList 保留无单称号查询范围：source.titleCode=null、空 rdjb、
source_default/空 titleScope.rdjb、page.rdjb=null。它只能在完整 annual/current title lineage
及当前 business_list 见证内参与 P/N，不独立证明某称号零记录；Z仍要求明确单称号范围。

query 与 asOf 使用严格带时区 instant，验证实际日历日期、时分秒和 offset，
允许至毫秒精度。先排除未来 query，再按 interface/conditions/title/fullRange 选 retry。
同刻所有陈述保留，不按 ID 判胜者。之后的同条件失败不能回退到旧成功；
未来失败不能遮蔽过去成功。无关或更窄 partial/failed 不抹掉独立充分 unrestricted 成功，
真正相反充分来源则保守冲突。查询失败不是成功零行。

annual 年度选择、最后业务、终审词表与 appliedAt 的 wall-clock 语义全部复用
buildAnnualProcess。本模块的 query parser 不改变该 authority。
2024 年正式周期与 2026 年观察可支持跨年比较；同年度公布与查询的先后确实影响结论且
无法证明时，返回 temporal_order_unresolved，不猜 1 月 1 日生效。

P 需要同事件、同原周期、当前 indexed record/version/contentHash、有效 supports_award/
supports_review refs，以及与当前 candidate 匹配的已有 confirmed finalQualification。
N 需要实际 latestStep 的 official_result_mismatch 和独立有效的同事件当前支持 refs；
N 可没有 finalCandidate，不能把所有 null candidate 当成 N。
P/N使用的当前查询与正式结论年度相同或更早、且无法证明结果先后时，同样返回
 temporal_order_unresolved；不只零记录支路受此保护，跨年度充分见证仍可比较。
annual选定逻辑步骤内全部历史观察都参与稳定字段、冲突与时间判断；因此逐一校验其
同事件/主体/称号、query覆盖和record/version/hash及sourceRefs，并将依赖纳入safe refs。
只有当前endpoint版本需要当前支持决定，不无差别要求历史版本重新confirmed。
每项依赖还须让query witness.interface、观察interface、businessRecord.interface一致；
相同queryId的annual/source coverage在接口、查询时间、状态、completeness和fullRange上
必须逐项匹配实际query元数据。目录查询不能借queryId充当business历史的覆盖证明。
未知状态、潜在更晚 scope gap、旧版本、撤回/需重核决定均不能套用 P/N。
sourceGeneration 与当前决定分别绑定：同 generation 不意味着决定没有变化。

## 两轴输出与 literal

`observation.state` 为 records/no_record/query_failed/not_queried/unknown；
`comparison.state` 为 synchronized/unsynchronized/not_established。
每周期包含 originYear、原样 batchSeq、state、闭合 reasons 和 safe refs。
source 摘要只返回 queryId、queryStatus、可用 outcome、applicability 与闭合 reasons。
未能验证可用性的来源 outcome 归 unknown；原始 metadata 留在输入与摘要中，不回传正文。

| 独立用例 | observation | comparison | 关键见证 |
| --- | --- | --- | --- |
| Z_unrestricted_zero | no_record | unsynchronized | 2024 eligible 周期，2026 exact-USCC 单 title unrestricted 完整零行 |
| P_same_event_current | records | synchronized | 同 event1、当前 record10/version11、有效决定401，annual 终审通过一致 |
| N_same_event_opposite | records | unsynchronized | 同 event1、当前 version12/决定402，annual 实际终审相反 |
| unknown_terminal | records | not_established | 新状态不能当相反终审 |
| failed_only | query_failed | not_established | 请求失败不等于平台无记录 |
| no_queries | not_queried | not_established | 无查询见证 |
| same_scope_same_time_conflict | unknown | not_established | 同刻相反充分来源不按 ID 消解 |
| future_top50_truncated | unknown | not_established | 截断后不能推断历史未查或全局无矛盾 |

同 title 仅汇总 authority 选中的相关当前周期。全部充分一致才 synchronized；
充分未体现可 unsynchronized 并列具体周期；source_conflict 阻断总体结论。
未判周期不能被另一周期的一致吞掉。无正式周期或仅平台行不签同步。
平台解释永不恢复正式失败、注销或迁出的资格。

reason 闭集按以下顺序去重；不是新 cszt 或人工决定词表：

```text
no_record_in_applicable_scope
same_event_result_agrees
same_event_result_not_reflected
query_failed
not_queried
observation_after_as_of
invalid_query_time
coverage_incomplete
metadata_truncated
cycle_unresolved
temporal_order_unresolved
formal_unresolved
source_requires_revalidation
source_conflict
platform_status_unmapped
```

## Canonical JSON 与摘要协议

canonical JSON 使用排序对象键、无空白 JSON、UTF-8、有限 number/string/boolean/null。
对象键与排序比较使用 JS 字符串 `<`/`>`，不使用 localeCompare。
拒绝 undefined、NaN、Infinity、函数、循环引用、稀疏数组、symbol key、非普通对象和对象 getter。
数组逐索引验证own enumerable data descriptor，再递归复制descriptor.value；
不会通过Array.from执行数组索引getter。输入先复制再归一和排序；不会原地sort。

可选字段有明确投影规则：page 缺 maxPage、completeness 缺 fieldGaps、annual input 缺
scopeGaps，在新 inputDigest 的归一副本中显式变为 null。显式 undefined 一律拒绝。
其余可选字段（例如 effectiveConditions 中未给出的 name/uscc/范围条件）保持键缺失，
不会被填成 0 或空串；显式 null 保留并影响摘要。字段仍必须满足导入类型的协议。
原 legacy hash 和 annual sourceGeneration 在归一之前按各自既有 JSON 协议验证。

以下字段名在本输入 schema 的所有层级被指定为集合数组；在副本中对每项递归归一后，
按整项 canonical JSON 字符串排序，不按数组原索引排序，也不按 locale 排序。
复合对象的稳定 ID、revision/hash 等 tie 字段均在整项序列中，不能只比较键集合。
数字集合的输入摘要排序也是 canonical 字符串序，不承诺数值排序。

```text
titles cycles evidence sourceVersions groups observationRefs
existingCorrespondenceIds existingCorrespondences currentDecisionRefs decisionRefs
eventIds awardEventIds evidenceIds decisionIds relationIds queryIds
observations titleScopeRefs coverage scopeGaps sources publishedNames fieldGaps
```

对应的主要输入位置包括：legacy.titles；legacy.titles[*] 和 formal.assessment 下的
cycles/evidence/sourceVersions/completeness/correspondence refs；formal.cycles 及其 eventIds/
judgment.awardEventIds；queries.sources；processes[*].input.groups、coverage、scopeGaps；
group.observationRefs、existingCorrespondenceIds、existingCorrespondences；
processes[*].sourceRefs.evidence/titleScopeRefs/observations/coverage；
processes[*].currentDecisionRefs、finalQualification.decisionRefs。
其中 correspondence.refs 本身叫 refs，不属于集合字段名名单，故保留其既有顺序。

名单之外的数组全部有序，尤其 processes、pages、unfinished、titleScope.rdjb、notes、reasons、
references、conflicts 和 normalizationConflicts。不得把 pages 排序后冒充原来连续完整读取。
集合排序不删输入重复项；输出 safe refs 按完整值去重，纯数字 refs 按数值排序，复合 refs
按 canonical JSON 排序。observation.sources 按 queryId 后整项排序；comparison.cycles 按
originYear、batchSeq（null 只作排序哨兵，输出仍为 null）排序。

重排 legacy titles 或 sourceRefs 后，仍须先满足各自旧 snapshotId/sourceGeneration 校验；
新摘要的集合归一不能免除这些旧协议要求。sourceGeneration 是实际 authority 代次，
不在这里重新定义成新 canonical hash。

摘要 framing 精确为：

```text
scope = {enterpriseId,titleCode,asOf,ruleVersion,assessmentVersion,legacySnapshotId}
inputDigest  = SHA256(canonicalJSON([version,scope,normalizedCompleteInput]))
resultDigest = SHA256(canonicalJSON([inputDigest,observation,comparison]))
```

完整实际输入与 refs 均进入 inputDigest，包括 legacy、原 timestamp 字符串、null、
query metadata、record/version/contentHash、event/evidence revision/hash、决定 revision/validity
和 sourceGeneration。即使时区写法表达相同 instant，原文不同也改变输入摘要。
resultDigest 使用完整闭合 observation/comparison，不省略未知周期或 refs。
两个摘要均为小写 SHA-256 hex，新摘要不改写旧 snapshotId。

## Refs、安全与资源界限

SafeComparisonRefs 只输出 eventIds/evidenceIds/queryIds/relationIds、event id/revision、
evidenceId/sha256、recordId/versionId/contentHash、decision id/revision、sourceGenerations。
不输出源文件路径、企业名称、rawFields、任意输入对象、metadata.error.message 或上游正文。
失败状态仅使用闭合 reason；queryStatus 只保留已知状态，其他值归 unknown。
安全边界依赖可信 adapter 提供真实 authority refs，本函数的类型和摘要不能认证任意远端上传数据。

最多接收 50 个 query 来源、40 个 process/event 输入；formal cycle 连接也不超过 40。
每个 query witness 与每个 process.sourceRefs 的 canonical UTF-8 字节数分别不超过 65536。
完整性校验最多 50 页，每页 pageSize 为 1–50。
这些是核心的显式守卫，不是全进程内存上界，也不能替未来 adapter 扩大现有 reader 预算。
既有 51 探测/50 返回保持；truncated=true 阻断全局结论，不能自行补查。
完整 annual scope 在原预算内无法证明时，adapter 必须保留缺口，不得拿分页值声称完整。

## R1 实跑与有限继承（历史，非当前修复候选）

分析/运行 base：a12f2a1cf36e7ed4e1dc03a5b93af15b54beac9d，
tree a085ff41efa0626a83829f3f9fca69cf0865679e。

| 证据 | 结果与边界 |
| --- | --- |
| 初次独立 RED | Z fixture 的 legacy/scope/cycle guards 后抛 new_feature_expected_RED；exit1，非产品回归 |
| 旧完整 core＋annual | core 69/69、annual 18/18，exit0、0 pending/skip；本候选有限继承，未重跑 |
| 父类型修正证明 | source 95a5df1661dda1707f95709ab3911c4b5ae2429418df8652330e6aaf4e2cb4a3 → candidate 067997a45385b3b149c6c12d0043c3407fb183d2320252d5a72c17b54c621976；只增加 map 类型上下文 |
| 擦除等价 | 父 TypeScript 5.9.3 固定 ES2022/ESNext/同 filename/no sourcemap，输出 JS 24667 bytes 全等；SHA 71847c6cf5c3865a554247293adeb35622bdc3d71e7c602756cccccc8075e67b，syntax errors0；本轮仅核 proof/source hashes |
| 新 fresh 类型验证 | 插件实际 resolve/load 通过，完整 nuxt typecheck exit0/signal null，raw TS/plugin gate 无诊断 |
| R1 测试文件 | SHA 4810714edb684f99e7aa6dfd95bf4d382dab909d2b2314a46739aafe160fb91b，与旧 87 项运行一致 |

旧初次 typecheck exit2（TS2322）、随后静态比较器 SourceFile.text 错误及 NameError 的 STOP
均保留；后两者是 harness 失败，不列为产品 FAIL。新类型通过不抹除旧记录。
旧测试 JSON 没有 unhandledErrors 汇总字段，该项仍 UNKNOWN。
独立 Z 摘要测试使用另一编码器与写死的 O/C/refs；另有 Python hashlib 固定 framing 向量，
不把 core 输出反算作 expected，也不宣称存在额外固定的完整 Z hex 文件。

原始证据在本机 /tmp/issue426-implementation-6BVZlN：green/green.json、case-evidence.json、
types/typecheck.log（历史 FAIL）、types-recovery2/{argv.json,run.json,plugin.log,typecheck.log,
plugin-validation.json,type-validation.json,release.json}。父证明位于
/tmp/issue426-parent-map-type-vket0ue5/runtime-js-equivalence.json。
每个运行 stage 有独立原 FREE 字节→BUSY grant，900/870/30 秒、5GiB、owned PID/birth
监控与 root-first/reap，release-FIRST 同 grant CAS 后读回 FREE。
新类型阶段最大抽样聚合 RSS 为 4025827328 bytes；短命未观察后代等监控界限保留。

本文档是新类型通过之后的独立后置 delta，没有参与旧 87 项测试或新类型运行。
未运行 full/build/HTTP/DB app/browser，也未触碰 3480/3481；没有生产验收、后继接线或默认激活结论。


## R2 审查修复验证（历史）

PR429 R1固定head0337f0fb发现Standards数组getter P2及Spec三项P2：P/N同年先后、
annual历史依赖闭环、原生apply_list覆盖。旧报告、原87项及全部FAIL/STOP/UNKNOWN均保留。

- 新增11个独立反例控制，旧69个core正文和期望保持。修复前单次RED：10 FAIL/1 PASS，
  原69项名称过滤未运行；失败均为预声明判定或refs断言，不是种子/导入错误。
- 修复后完整core 80/80、原annual 18/18，合计98/98，exit0/signal null，0 skip；
  原始JSON各failureMessages为空。aggregateUnhandled字段缺失仍UNKNOWN。
- 新插件实际resolve/load及完整typecheck均exit0/signal null，raw诊断gate干净。
- 原始运行：/tmp/issue426-implementation-6BVZlN/r1-red-parent、r1-green-parent、r1-type-parent。
  两个GREEN/type运行各自sourceExact，release-FIRST原字节CAS及FREE读回保留。
- 文档为类型验证之后的后置差量；core与tests字节绑定上述新运行，未重build/full/HTTP。

修复仍只涉及原三个owner，不改默认407-v1/current/export或annual authority。此处记录本地
门禁，独立R2审查、CI与生产不由本次测试代签。所有新生产路径仍未激活。


## R3 来源交叉绑定验证

R2 Spec保留一个F2部分闭合P2：历史business观察可借recognized_list查询覆盖。
新增四个独立控制覆盖query接口、业务版本接口、annual coverage接口及时间错配；
唯一修复前RED为4 FAIL、80项名称过滤。修复仅收紧逐依赖来源交叉核验，未改annual策略。

新完整core84/84、原annual18/18，共102/102，exit0/signal null、0 skip，failureMessages全空；
合法历史借证正控与原生apply_list佐证正控均保留。新插件实际加载及完整typecheck通过，
原始日志诊断gate干净。source精确绑定，文档单独后置；aggregateUnhandled字段缺失仍UNKNOWN。
原件：/tmp/issue426-implementation-6BVZlN/r2-red-parent、r2-green-parent、r2-type-parent；
源码/断言与交付证明：/tmp/pr429-r2-parent-fix-qhyfsoll。

所有旧R1/R2静态反例、历史RED/FAIL/STOP及UNKNOWN均保留。独立R3尚待审，不自签闭合。
未运行full/build/HTTP/DB app/browser/CI/生产，默认reader和后继消费者仍未接入。


## #430 空原年周期连接修复

核心的 event/cycle join 复用既有 qualification-cycles.originTime：已知 year 优先，
仅 award 的 year=null 可使用 decidedYear；review 不借结论年填原周期。
两年皆未知或原周期错配仍拒绝。原 year/null、decidedYear、anchor、source 值及旧
snapshotId/hash 保留，未知 batch 不填 0。不改正式资格、annual/P/N、预算或默认接线。
新增的运行时模块为纯 qualification-cycles，它只 type-import lifecycle，无 IO/DB。
旧核心的 value 依赖仍为 node:crypto 与 annual-process（后者 value-import domain）；
类型导入的 current-qualification 和 server reader 不因此成为运行时依赖。

本轮固定 base bceec6c3a9867f544e25418fb44cd60a3816c18d /
tree 0fa62f00dac18195f691863de76a140cb035bc48；fresh 验证如下：

- 新增六例首次 RED：2 FAIL / 4 PASS，旧84项按名称过滤为 skipped。
  两个合法 null-origin case 均在旧 hash/值断言之后抛 invalid_cycle_event；
  旧报告校验器误要求 filtered=pending 的 AssertionError 原件保留，未修未重跑。
  父独立接受 expected RED，证明 /tmp/issue430-parent-red-proof-g_b1guvz/proof.json。
- 仅改已审两处 core 差量后，一次完整 core90（旧84＋新6）与原annual18，共108 PASS，
  exit0/signal null，0 skipped/pending，各case failureMessages空，fullnames逐例核对。
- 独立 grant 下插件实际 resolve/load 及完整 nuxt typecheck 均 exit0/signal null；
  raw TS/module/plugin 诊断 gate 无匹配。各lane sourceExact，测试从RED冻结未变。
- 两lane均 release-FIRST，同grant原字节CAS及FREE读回；900/870/30秒、5GiB、
  owned PID/birth监控保留。aggregateUnhandled字段缺失与短命未观测资源仍UNKNOWN。

core SHA256：c62e69274f05bf49d556f492d38f4766f125068f79f9a80c8b38535d99f6e540。
tests SHA256：226fe22c5d8fd79a3d851c44009818ad9b1c9a695dc4b0815cf1a19f3803f9af。
原始运行 /tmp/issue430-implementation-e0ywgcip/{red,green,types}，完整逐例证据
在 green/validation.json；输入真实literal出处为#427的null-origin-input.json，永久
测试内嵌完整JSON、无/tmp运行依赖。无query真实原输入与另借z的合成2026完整Z分别控制；
合成query不冒称真实SQLite曾有该query。原DTO/hash、year=null和正式eligible保持。

本文档为类型验证并释放之后的后置delta，未参与上述运行；core/tests字节绑定新运行。
旧#426 102PASS仅历史证据，不作为此次fresh证据；所有历史FAIL/STOP及UNKNOWN保留。
未运行build/full/HTTP/DBapp/SDK/browser/CI/生产；未实施#427/#428/#410。
默认407-v1/current/export和生产消费者仍未接入。此处只交dirty候选，不自签独立审查。


## #427 显式 reader 候选（未启用公开消费者）

`createCurrentQualificationAssessmentReader(db, receiptRuntime?)` 新增：

```ts
readPlatformComparison(enterpriseId: number, asOf: number, title: CurrentTitle): PlatformComparison
```

它独立返回 `platform-comparison-410-v1`，scope 绑定完整旧 `legacySnapshotId`，
另有 `inputDigest`、`resultDigest`。调用者提供评估时点；它不接收外部资格、coverage、
对应决定或 annual 事实。默认 `read`、`readCurrent`、`readWorkbook`、`readTitle`
均不调用比较 core，不向旧 titles 增添未计入旧摘要的字段。

实现只在一次外层 SQLite transaction 中复用完整原 `readSnapshotBody`，
再取实际 metadata 并调用唯一 core。默认读取仍保留原 transaction wrapper 的语义。
私有单向 collector 取同一次 `adjudicateQualificationCycles` 的当前 judgments 和 formal，
按既有 `originTime` 连接 eventIds；不重复选周期、不从平台维护年或批次猜周期。
#430 允许的 award 原年 null 通过既有 authority 解释，原 DTO、null 和旧 hash 均保留。

内部 `readQueryComparisonWitnesses` 共用原 selector 和 `coverageOf`，保留全部候选 source、
原 queryKey 与经 schema 验证的窄 metadata；不使用聚合 status/latest map 代替完整来源。
原 ownQueryIds、identity variants、同称号筛选、top51 探测／返回50 和 truncated 语义不变。
不先过滤未来候选来消除截断；严格 asOf/time-before-retry 仍由同一 core 判断。
SQL 只提取既有窄 metadata 字段；不额外读取 raw_response、整份 raw_fields 或来源正文。
metadata.error 进入输入摘要，返回仍只有闭合 reason 和 safe refs。

暂时 `processes=[]`。2024 eligible 周期与 2026 exact-USCC 单 title unrestricted
完整成功零行可得到 `no_record / unsynchronized`，正式 group 不变；失败、partial、
缺 metadata、同年先后未知、截断或 records-only 不冒称一致。原生 apply_list 的无单称号
范围不能单独签 Z。年度 P/N 接线由 #428 承担。

调用者外层事务不会被提交。活跃 iterator 导致 SQLite busy 时直接抛出，不 fallback/retry；
应先耗尽批次再调用。双连接 WAL 测试证明 body 与新增 metadata 共用一个 snapshot，
后续调用才看到另一连接已提交的新来源；reader 仅复用请求内 handles，不缓存 T2/结果。
在本次小合成 fixture 中，相比完整默认 read，新方法执行额外2条 SQLite statement；
这是该 fixture 的实测差量，不是全局性能或总内存上界。核心原有40周期、50来源、50页和
单 witness 65536 bytes 守卫保持，超限不截断后冒充完整；错误原码传播。

本次候选在 base `09c2bb5c76df6250c64b5f13a5c4bc12a06179c5` 上分层 fresh 验证：
新 reader 39、原406含新增默认控制37、工作簿含新增控制18、core90、annual18、既有408查询86，
共288个不同 case PASS、0 skip。首次最窄两例在扩矩阵前单列通过，不重复计入288。
默认406对照实现前冻结的完整旧 DTO/旧hash，默认工作簿按实际 worksheet values 与完整
scope/snapshotId 独立复算 D409 摘要，并断言默认路径 core 调用0。
插件实际 resolve/load 与完整 typecheck 均 exit0，raw TS/plugin gate 无诊断。
原始运行与逐例 fullnames 在 `/tmp/issue427-integration-sct6ti/`；所有 lane 源绑定，
独立900/870/30秒、5GiB grant 均 release-FIRST/CAS释放读回FREE。
aggregate unhandled 字段缺失及短命未观测资源仍 UNKNOWN。

本文为运行完成及释放后的文档 delta，未参与上述运行；实现与测试源码另有精确 pin。
旧 #427 首 RED、真实 Gate3、#426/#430 的历史 FAIL/STOP/UNKNOWN 全部保留。
build/full/HTTPapp/SDK/browser/CI/生产及 #428/#410 未运行；无 commit/push/PR/独立审核。
候选保持 dirty 交父核验，以上不等于公开消费者已启用或生产验收通过。

## #433 完整周期绑定候选（STOP，未签交付门禁）

固定 base 为 09c2bb5c76df6250c64b5f13a5c4bc12a06179c5，tree 为
826f4e33c52d13c136af15c616bb5614ddda923b。以下是未提交候选的实现与证据记录；
执行者在静态读回脚本失败后继续运行，违反本轮 harness FAIL 即 STOP 指令，
后续通过不能覆盖该流程 FAIL，候选须交父处理，不宣称 dirty-ready 验收通过。

候选从正式 evidence 恢复有证据的 award/review，使用既有
adjudicateQualificationCycles 验证完整周期多重集合及每项 judgment/direct membership。
不改写传入 authority 结果，不改资格算法、reader、默认版本，不增加 cycleId。
合法 failed-only/future null anchor 保留；同原年多个未知批次授予各自保持独立成员。
遗漏、重复及伪造绑定拒绝。原 legacy/selected assessment/local join/event/anchor
检查在新增完整性检查之前，保留旧错误优先级。

当前周期 facts 按原年和批次一次建索引；每个已知批次为一个 direct 分区，
未知批次的每个授予独立分区，只有无授予/已知批次时才有 reviews-only 分区。
同年未知批次 review 是判断依赖，参与依赖 refs，但不扩张 process applicability：
process 仍只匹配 direct eventIds。source refs 同时要求 evidence 与所属 event 一致，
不能借错属来源。输出同原年/批次 tie 使用完整规范化行排序，保留周期多重性。

最多 40 个分区，原 authority 最多调用 41 次（全 facts 一次、每分区一次）；
局部输入总量至多 D + 40R，其中 D 为 direct facts 总数，R 为同年歧义 review 数。
事件和 sourceVersions 一次索引；没有每 binding 无界重扫完整 facts 或二次 SQL。
此界限不宣称原 authority 内部、canonical 排序、P/N annual 路径或全进程线性，
不提供整个输入的常数内存保证，不改变已有 reader 预算。

测试内嵌 54 个完整独立 literal input/expected，无运行时 /tmp 依赖，无生产 helper
生成 expected。原合法 P/N/Z 和 #430 的 inputDigest/resultDigest 均逐字兼容；
歧义 review 依赖新增 refs 的 resultDigest 按独立 literal 修正，inputDigest 仍绑定完整原输入。
sourceVersion 对每个 evidence 的额外全覆盖要求本票未实施，另留 Git 外开票反例。

两个旧 synthetic 明确保留原输入并改为拒绝控制：no_formal_cycle 与
formal_excluded_not_revived 均清空 cycles 却保留正式 award；旧预期为 records /
not_established，新预期为 invalid_cycle_join，后者仍验证 excluded 原值不变。
另有真正空 formal 与 failed-only 合法控制。其余旧 oracle 字节保全，原文和 inverse
分别保存在本轮 synthetic-changes.diff 与 synthetic-inverse.diff。

运行原件在 /tmp/issue433-implementation-8Utg14，以下结果与流程 FAIL 分开记录：

- 依赖原不存在；仅一次 offline/frozen/ignore-scripts install 与自有 emptydotenv prepare。
- 无生产改动的预声明 RED：四项合法输入先验证旧 hash/原值，随后均在旧 guard
  抛 invalid_cycle_join；4 failed、142 skipped，属于预期行为 RED，无 RED harness FAIL。
- 后续静态读回脚本 TypeError（取到较早 JSON.parse）及 AssertionError（错误比较
  含 provenance/status 的外部 envelope）均为 harness FAIL。执行者修正脚本继续，
  未及时 STOP；原记录保留，不能用之后的验证抵消。
- 此后一次完整 core + annual：实际 JSON 171 passed，0 skip，failureMessages 全空；
  exit0/signal null。独立插件实际 resolve/load 的 SHA 为
  0186b559341b0cfebf9c3f3faf0595ca173e934ea0db73fc0e462ebbcc9c15d1；
  完整 typecheck exit0/signal null，raw TS/module/plugin 诊断 gate 无匹配。
- 各 lane 独立 grant、锁及原字节 CAS，release-FIRST 后读回 FREE；源码运行前后
  完整 SHA 一致。900/870/30 秒、5GiB、owned PID/birth、root-first 边界保留。
  aggregateUnhandled 缺失及短命未观测后代/handles 仍 UNKNOWN。

历史 288/type 仅属 #427 继承，不计本票 fresh；旧 FAIL/STOP/UNKNOWN 全保留。
本文为释放后的后置记录，未参与上述测试/typecheck。未运行 build/full/HTTP/DBapp/
生产，没有 commit/push/PR/review/委派，未实施 #427/#428/#410。


### PR434 R2：提供的来源仍须独立校验

R1 Spec F1 指出：错指同周期另一事件的来源被 refs 过滤后，两个 null hash
可能绕过原有重核阻断。修复在未过滤的 dependency sources 上独立检查非空 hash
及 event/evidence 归属；既不把错属来源加入 proof refs，也不补造缺失来源。

六项独立回归覆盖正确事件、同周期错误事件、不存在事件 × 空/有效 hash。
原候选 RED 为 2 FAIL/4 PASS，153 名称过滤；固定测试字节后完整 core159＋annual18
共177 PASS，0 skip，插件实际加载及完整 typecheck 通过。各窗口先释放锁再整理证据。
原171 PASS与流程FAIL、R1 P1均保留；未观测unhandled/handles仍UNKNOWN。
本节为运行后的文档差量，不外推#427集成、build/full/CI/生产。
证据：/tmp/pr434-parent-f1-6axyguga。


## #427 R2 reader：direct 成员与歧义 review 依赖

#433 的严格 core 校验合入后，reader collector 须保留 authority 的周期实例多重性。
同原年 null 批次的每个正式 award 都是独立的可能周期，不能按 year/batch 把全部
award/review 填入每个 binding。collector 按 formal 输入顺序，将 authority 的逐 grant
输出连接到对应单个 direct event ID；即使未来 grant 的 anchor=null、awardEventIds=[]，
也不以锚点或授予 ID 列表猜成员，不重判正式资格、不补 year/batch 或裁掉周期。

已知批次仍保留同原年/原批的直接事件；仅在该年既无已知批次分区、也无未知
批次授予分区时，reviews-only 才以该 reviews 集合作为 direct 成员。同年未知批次 review 是 core 处理的判断依赖，
进入完整依赖 refs，但不混入每个 grant 的 direct eventIds 或扩大 process applicability。
完全相同的 judgment 也不能合并：两个不同直接事件仍保留两个周期实例，输出 tie
顺序由 core 的完整规范化行排序；本票不增加 cycleId。

本轮 reader 小修由父执行，只改 current-qualification.ts。固定实际 HEAD
35fe48b80d278cca1a7739daec875d0a826e38b9 / tree d683a0917130e03afa56511c1b9a34bafeabcf87；
reader SHA256 929ee6610c9322cfe0f91ebdbf00e6cdb53dbe15b98ad1b1705d9ab4b61fa6bb，
冻结测试 SHA256 5f971c87b35180d00dfb4e4a779b762b3c7055e768e28bc4df1ec8007e496bb2。
测试仅尾部增加八组真实 SQLite 独立 literal，原39源码前缀和旧406/workbook完整保留。

历史 RED 与本次 GREEN 分列：

- 首次 selector 因 `$name` 格式化为带引号/截断 fullname 未命中，47 全 skipped，
  进程exit0而runner STOP；没有业务guards执行，不能算产品RED。原HARNESS_STOP保留。
- 父授权 recovery 从原JSON机器导出唯一实际fullname selector；源码不变，静态47名
  恰匹配1。实际1 executed/46 filtered，在完整legacy/hash/周期/source/零写guards后
  抛 invalid_cycle_event；两个binding实际都为[1,2]，独立literal要求[1]、[2]。
- 父 reader 窄修后，本轮静态TS解析、diffcheck及前缀/authority保护通过；随后唯一
  完整reader文件47/47 PASS、0skip，八组guard/captured binding均匹配独立literal，
  完整公开refs、双digest及finally只读断言也通过。此次不使用 -t。
- 独立相关回归：406 37、workbook18、core159、annual18，共232/232；另有原408查询
  86/86，均0skip。共365次case执行；格式化后同名的参数项保留多重性，不宣称365个
  不同fullname。159/18是本轮新core/annual fresh，不沿用旧90/18或父177的运行结论。
- 实际插件resolve/load及完整typecheck均exit0/signal null，raw TS/module/plugin gate空。
  所有 lane 运行源码字节一致，各自新grant900/870/30秒、5GiB，先CAS释放读回FREE
  再整理证据。实际原始JSON和逐例captured绑定位于/tmp/issue427-r2-green-c9y7LV。

failed-only/null anchor、future known/null batch、不同decidedYear的双未知批次、
known+unknown awards与歧义review、reviews-only、相同judgment的不同direct及反向
插入均有独立完整binding/refs literal；expected不由生产helper生成，call-through不stub结果。
默认407-v1/完整旧DTO/hash、默认core调用0、metadata51/50及time-before-retry、Z范围与
processes=[]、原事务/WAL/预算规则保持；没有修改core/qualification/annual authority。
小修增加的成员选择遍历不被宣称为全局性能或内存上界修复，原预算限度仍适用。

本文是全部运行及释放后的文档delta，未参与上述执行；code/tests与source/run清单另行绑定。
旧288/type、父#433的177/type和本票旧窗口证据均仅继承，不冒作本次执行；全部历史
HARNESS_STOP、RED、Gate3、#426/#430/#433 FAIL/STOP及读取偏差保留。
aggregateUnhandled字段缺失与未观测短命资源/handles仍UNKNOWN。
未运行install/prepare/build/full/HTTP/DBapp/生产，未commit/push/PRbody/review/merge/watch，
未委派或启动#428/#410；dirty-ready交父提交和重新安排双轴复审，不自签公开消费ready。


## #435 独立修订域与真实平台 hash 协议

比较输入继续限定为可信 reader 在同一个只读 snapshot 内装配的 authority 投影。
current-qualification 的 sourceVersions 按 evidence ID 从
`official_evidence_row_revision order by revision desc limit 1` 取当前 capture；
event revision 则由事件写入 authority 独立推进。新增 evidence 可以是 row revision1，
而所属 event 已是 revision2；更正一行也不会推进同事件其余 evidence 的行计数。

core 的两处来源 guard 因此分别验证 capturedRevision 为正安全整数，不再要求它等于
事件 revision。event/evidence 归属、未过滤的 dependency sources、当前 file/capture hash、
removed、sourceRefs.event.revision、sourceGeneration、平台版本引用与当前决定保护仍保留。
`sourceRefs.event.revision` 负责拒绝旧事件来源混用；capture 的 latest 保证来自可信 reader，
不是由两个计数相等证明。类型和摘要不认证任意上传输入；若要让 core 独立认证历史
capture 当前性，须另过 Gate3，本票没有增加 witness、reader 或全 evidence 覆盖规则。

hashAlgorithm 显式兼容 `platform-row-json-v1` 与旧纯输入 `sha256`。
真实 writer 存储的是 SHA256(`platform-row-json-v1\n` + canonical JSON) 的协议标识，
不在 adapter/core 改名，也不读取 raw 正文重算。未知、未来、null 或大小写变体协议
仍拒绝；小写64hex只是形状条件，不能代替身份、版本、interface、来源和当前决定校验。
旧 DTO、默认407-v1/current/export、摘要 framing/normalizer/sourceGeneration 均未修改。

固定 HEAD `2e40399fe23c73ef67f5c42e4fb186c713a431bc`，tree
`ecee92c38919ac5808b668ba8a188c9e311badc6`。本候选仅三 owner：core/tests/本文档。
测试原全文 prefix 和全部旧 expected 字节保留，尾部追加40个冻结完整 input/expected。
覆盖 P/N/Z、event7/rows1与3、单行更新、同值旧事件sourceRefs、file drift、removed、
wrong ownership、ABA、撤回/当前决定、版本/interface、未知协议及非法内容hash。
每例固定名字；独立文档编码器验证摘要，deep freeze/finally验证输入无变更。

证据及历史状态分列：

- 首轮三个正向 guarded RED：3 executed/failed、196 filtered，分别为
  `issue435_P_event7_rows1_3`、`issue435_P_platform_protocol`、
  `issue435_public_safe_facts_synthetic_legacy_shell`。原值、legacy hash、sourceGeneration、
  独立digest guards均到达，实际唯一cycle reason为source_requires_revalidation。
- 首轮后处理误要求failureMessages包含方法名toEqual，Vitest实际措辞为to deeply equal，
  形成harness STOP；原validator/validation/log均未修改。父独立核原JSON、精确fullname、
  898行末断言及三组marker后接受业务RED，证据`/tmp/issue435-parent-red-dxc_xv26/decision.json`。
  没有重跑setup或RED；后续通过不抹除历史STOP。
- 恢复后唯一完整 core199＋annual18，共217/217 PASS，0 filter/skip，全部failureMessages空。
  40组完整结果等于冻结expected；新旧input/expected未因GREEN修改。三个原RED的
  inputDigest保持，修复后的完整resultDigest匹配独立expected。
- 新独立类型lane：插件真实resolve/load（vue-router5.4.0，SHA
  `0186b559341b0cfebf9c3f3faf0595ca173e934ea0db73fc0e462ebbcc9c15d1`），
  完整typecheck exit0/signal null，raw TS/module/plugin diagnostic gate无匹配。
  NODE_PATH仅该类型lane使用本WT的node_modules/.pnpm/node_modules。
- 每lane独立同grant锁CAS，900/870/30秒、5GiB，PID/birth/root-first/reap保护；
  release FIRST并读回FREE后整理证据。运行前后全部1819个tracked源码SHA无漂移。
  aggregate unhandled缺字段及短命未观测资源/handles仍UNKNOWN。

原始运行在`/tmp/issue435-implementation-gBBI8c/{red,green,types}`；新版结构化校验
另存validation-v2，不覆盖旧harness STOP。完整source→run、diff/inverse、逐例AC见final/。
真实反例literal仅formal/queries/processes采用原安全事实，缺失的legacy剩余字段明确
使用合成壳，不冒称原公开完整input；#428实际公开装配回验仍UNRUN。

本文为所有运行完成、释放后的后置delta，未参与上述测试/typecheck；core/tests字节
与运行绑定。未运行full/build/HTTP/DBapp/CI/生产，未改#428，未commit/push/PR/review/merge。
交父三owner dirty-ready候选，独立审查与合并由父处理。

### #428 年度存在性与 query-only 装配

显式比较保留完整 query witnesses。recognized 查询的状态、时间、retry、条件、title、分页与实际 canonical 65536 字节限制仍由原比较 core 裁定，不把 failed/partial/future 查询当作年度业务实体。年度适配器仅在同一 snapshot 的标量 SQL 证明真实年度来源及保护图为空后返回 `processes: []`；不构造空 process，也不对该空路径构造年度 sourceRefs 或收取年度 W。

native `apply_list` 的 `titleCode:null`、`rdjb:''` 和 `source_default` 是合法查询范围。完整零 archive 可证明无年度实体，但该查询仍不能独立建立单 title 的 Z，原 core 保留 `coverage_incomplete`。实际 unknown-title 行仍保留；未完成 process 查询、保护-only 决定或闭合不足抛 `platform_comparison_scope_unavailable`，不得回退空数组。非法 proof/history 不被空路径吞掉。非空年度来源沿原年度装配及资格 authority，真实超限为 `input_resource_limit`；SQLite busy 保留原错误。

父已批准仅对 `reader427 business_records_no_process` 精化 reason：原输入为成功 business 查询、一条未索引业务行、null record/version、无决定；原 query-only 阶段为 `coverage_incomplete`，真实年度装配后为 `source_requires_revalidation`。`observation: records`、`comparison: not_established`、默认完整 legacy、零写及完整 T2/digest 规则不变。原断言和历史 FAIL 保存在 Git 外交付中；此条不授权其他 reason 批量变化。

空路径经父事前冻结的额外 SELECT 上界为 `2+2E+1 <= 83`（原 witness 两次、每 event 两次 header、一次 probe）。非空保留 `B=22+9E+3S+ceil(U_RT/400)+2ceil(U_obs/400)`、enrichment `<=4E` 与总增量 `<=667`，probe 替换旧 absence 一个 SQL 槽。旧 `reader427 unchanged_legacy_coverage_and_two_additional_statements` 的 +2 oracle 经父事前公式批准，单项替换为 `reader428 query_only_budget_preserves_default_bytes`：E=1 为5、全局83；完整 reader47 无过滤通过。原断言、inverse 与批准 proof 保留于 Git 外，未按实测结果提高阈值。W16MiB 及16倍仅 policy 收费，不是输出/heap/RSS 数学上界；实际 SQL 模板、payload、RSS 与扫描计划必须独立记录。实测小 trace 空 Z 为5、closed P 为43；这只验证小控制，不代表全局 CPU 或容量验收。


### #428 最终候选与证据边界（运行后文档差量）

基线为 #435 合并 `10728732e4c7310a3828d03546caeb4281301f80`，tree `f79d823f30274ac7bb571ec758655051d8c88c9a`。九 owner 内八文件修改；纯比较 core、其测试、正式资格/normalizer/schema 均保持基线字节。默认 annual 与 sourceGeneration 原 JSON 顺序不变，默认407-v1/current/409导出不启用显式 comparison。人工 confirmed_no_diff 不自动写入。

真实年度实体存在时必须完整闭合实际 query/title lineage、保护 history/决定与当前 record/version/hash；未知或不可闭合抛 `platform_comparison_scope_unavailable`，实际超限抛 `input_resource_limit`，SQLite BUSY 原错直传且不 retry。只有真实年度实体及保护图为空才省略 process；queries 完整交原 core 裁定失败、partial、future、retry 与 coverage。41 cycle 保持原 core 错误优先级。批次内按 scope 复用读取，不逐 event 重复 full-loader；不读 raw_response。

入场收费采用 row64/title64/history128/decision128/evidence160、raw7、proof4096/100、A1MiB/U65536/W16MiB。W 的16倍是 policy 收费，不是数学输出、heap 或 RSS 上界。query-only 的65536按实际 canonical 长度裁定，不拿保守 upper 当实际字节。exact/one-over 使用真实 SQLite 接缝；不可表示的 A/queryUpper/proof 字节边界只标 nearest reachable/qualified，不捏造无效 facts。部分 EXPLAIN、采样 RSS 与 pure19 不证明严格扫描 CPU 或内存界。

已执行证据按各自源码绑定继承，不合并宣称本次全部 fresh：

- 完整 adapter72 + reader47 =119，含已批准的新预算 case，无过滤；相关五文件 core199、annual-process18、406 37、408 86、workbook18 =358，无过滤。annual-process18 不是 annual-read23，也不包含2k容量。
- 真实公开 fixture 文件30项通过，包含 P/N 三称号×award/review、版本/当前决定/ABA/撤回/历史及时间反例。后续两测试 owner 类型修复含 notnull/Reflect.apply 实际行为差量，仅针对 partial 装配与 trace Z/P 三项复验；不是重新完整执行119/358/30。
- 插件真实 resolve/load/hash、完整 typecheck/raw gate、独立普通 build 通过；1877产物完整集合冻结。构建 warning 保留，不推出浏览器功能验收。
- 隔离 built 唯一执行：真实 HTTP 公布证据→档案→索引→对应决定→annual/current，实际 compiled 内部 reader 单列 synchronized；默认完整407/hash、sourceGeneration 和读窗口 total_changes/data_version/DB-WAL hash 零写断言通过。固定 asOf 与 current 实时时点各自核 hash，不错误要求相等；没有公开显式 comparison consumer。
- built runtime 同 grant CAS release-FIRST FREE，observed owned 余0；6.625秒、21次采样峰值1,090,469,888字节仅为此次观测。实际 job/child drain 完结条件通过；具体 job 数/轨迹、可选 candidate 分支未归档，不补称已观察。

历史7/2FAIL、16/22FAIL、分页失败、四个类型FAIL、准备 syntaxFAIL、provider中断及全部STOP保持原件；后来PASS不覆盖它们。aggregate-unhandled、未观测短命进程、独立 DBclose/handles、完整 server stdout/stderr、CPU complexprobe 与数学内存证明仍 UNKNOWN。2k/20k、full suite/CI、生产与独立双轴审核未运行，不宣PASS。

证据入口：`/tmp/issue428-final-gates-tktdl60x`、`/tmp/issue428-types-resume-1_525427`、`/tmp/issue428-built-safe-li4ku_l5`、`/private/tmp/issue428-built-runtime-9s7ra9we`。最后一层为已批准限定 compiled 验收；本节是随后文档收尾，未参与上述运行。完整 source→run→artifact 与逐AC由 Git 外候选交付包保存，独立 Spec/Standards 与合并由父处理。
