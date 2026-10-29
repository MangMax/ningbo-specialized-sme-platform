# 平台同步解释纯核心（#426）

`lib/roster/platform-comparison.ts` 提供同步纯函数
`comparePlatformComparison(input: CandidateComparisonInput): PlatformComparison`。
新投影版本为 `platform-comparison-410-v1`。它解释已经归一的来源见证，
不生成正式资格、不写人工差异原因、对应决定或审计。

本模块尚未接入 reader、HTTP/MCP、列表、筛选、详情或工作簿。
默认 `enterprise-qualification-407-v1`、current/export 及旧 snapshot/hash 不变。
#427/#428/#410 不属于本次交付；纯算法通过不代表它们已具备生产输入或通过验收。

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
