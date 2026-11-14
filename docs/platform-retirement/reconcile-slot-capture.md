# #763 A：reconcile 四槽旧封套捕获契约


状态：docs-only 候选，pending 父级独立 Standards/Spec review 与 LOCAL 接受。A 不授权 B。级别 L，难度高；离线捕获、新写重放和显式运行接线分三片 ≤M，见末节。本文是表示和验收契约，不是已运行证明。

固定基线为 `3f8085abe5bb8b5c5c2221495a40c68e84f086db`，tree `0b7fc5874bf9477bef3a0389e9cbd8346d9a0a7f`。实时 #763 正文及 comments 冻结于仓外证据 root `/Users/mang/.t3/acceptance/platform-complete-migration/reconcile-slot-capture/contract763/issue763.frozen.json`，updatedAt 为 `2026-11-13T03:52:46Z`。冻结文件 SHA256 为 `e80b007ecd55cca24454d001f68d2d6c116ccdf1fc9b2c993e6671b992c62d41`。

本文补充[主契约](contract.md)和[补充 ADR](../adr/2026-11-13-reconcile-slot-capture.md)，保留企业、平台业务记录、内容版本、采集观察和差异决定的词表边界。capture 只回答“原旧槽封套是否通过原重验”，不裁定企业资格、差异或归属。

## #770 原重放输入补充，pending 独立接受

[原断言归属补充](reconcile-replay-input.md)与[对应 ADR](../adr/2026-11-13-reconcile-replay-input.md)是 scope:M docs-only 候选。本页 §1、§3.2、§5.3、B07/B09 将 fallback `payloadRows` 视为 exact immutable replay 输入的推论已被父级正常路径与实际 producer/comparator 探针证伪：原 SQL NULL/空对象不等于合成对象。原比较与 validator projection、持久化 exact original、请求 own assertions 须分责。原文字及历史证据保留，不能再单凭合成行声明重放保真。

补充候选选择已有受约束 reference 语义，并为旧成功请求保留完整旧编码和 committed key/receipt。它覆盖 metadata、sequence/key/raw、全部源列、alias/sourceText、native status、逐观察原输入及失败恢复，不授权另一次逐字段补丁。所有新实现/测试/target carry 仍 UNRUN；A pending 父级固定对象 Standards/Spec 和 LOCAL 接受，B 未授权。#769 不变，target 在固定已接受 B 后另归 #768，#768/#763/#706 NOTREADY，global guards CLOSED。

## 1. 原输入、源码 owner 与现状

下面的行号属于固定基线。路径链接指向实际 owner；B 可在这些边界内增加窄模块，不把每个 helper 拆成票。

| 输入或责任 | 实际源码 owner | 本票约束 |
| --- | --- | --- |
| 四槽传输与封套 producer | [client.ts](../../lib/platform/client.ts) `LegacySlotCollection:69`、`queryPlatformSlots:310`、`queryAllRdjb:409` | business_list 的 rdjb 1、2、3，apply_list 的空 rdjb。recognized_list 不参与 |
| 页 parser 与旧字符串 projection | [adapter.ts](../../lib/platform/adapter.ts) `normalizeRow:172`、`parsePlatformPage:351` | 接口对应 grid、嵌入 JSON 与表格解析保留；不能用通用 scope parser 替代 |
| 原封套 validator | [client.ts](../../lib/platform/client.ts) `validateLegacyPage:267`、`readCompleteLegacySlot:279` | 旧完整性谓词的唯一运行语义依据。capture 边界调用原规则，literal oracle 独立写预期 |
| 原最新选择、typed payload 和分类输入 | [platform-reconcile.ts](../../server/utils/platform-reconcile.ts) `storedRawFields:255`、`legacyRowOf:274`、`freshStoredSlotsSnapshot:291`、`toQueryInput:497` | 三种输入分别保留，不能以一个 DTO 代替 |
| 原逐观察 normalization | [normalization.ts](../../lib/platform/normalization.ts) `normalizePlatformRelation:39`，以及 [identity.ts](../../lib/platform/identity.ts) `processFactsFromRow:76` | 七字段 stored/source/reconciled/conflict，不按 version 补值 |
| 原 payload producer 与导入 replay | [payload.ts](../../lib/platform/payload.ts) `collectRelations:229`、`platformQueries:441`，[query-replay.ts](../../lib/platform/query-replay.ts) | `rows` 是旧字符串行，`rawRows` 是原 typed 行。复用 raw 为空，由旧自然键解析原采集 |
| T04 集合、页、归档与绑定 | [collections.ts](../../upgrade/collections.ts) `transfer:127`、`targetRow:76`、`upgradeCollections:181` | evidence 优先于 supplement，rawResponse 只归档；不改变此优先级 |
| T05a 原观察与原 cells | [observations.ts](../../upgrade/observations.ts) | 全 relation 覆盖、sequence、旧 alias、rawFields/sourceText/legacyRowSnapshot 保留 |
| T05b 逐观察比较事实 | [projections.ts](../../upgrade/projections.ts) `transferObservation:73`，[source-extraction.ts](../../lib/platform/source-extraction.ts) | 已有 observation-owner 分支，包括无 version 观察，承接分类输入 |
| 目标基础与扩展声明 | [schema.ts](../../db/schema.ts) collection/page/三投影，[target-schema.ts](../../lib/platform/target-schema.ts)、[process-stored-schema.ts](../../lib/platform/process-stored-schema.ts)、[apply-stored-schema.ts](../../lib/platform/apply-stored-schema.ts) | 新 capture 放 collection；业务字段仍在本源 observation 投影 |
| 新 collection 事务 | [collection-target-command.ts](../../lib/platform/collection-target-command.ts) `writeNewCollectionTarget:80` | 归档、alias、全部观察、capture 与 caller receipt 同事务提交 |
| 来源 writer、真实旧写物化 | [process-target-writer.ts](../../lib/platform/process-target-writer.ts)、[apply-target-writer.ts](../../lib/platform/apply-target-writer.ts)、[process-materialization.ts](../../lib/platform/process-materialization.ts)、[apply-materialization.ts](../../lib/platform/apply-materialization.ts) | 原命令与物化后旧存储事实不同；capture 认证实际物化结果，不能只认证 request |
| 原 snapshot serializer | [relation-evidence-snapshot.ts](../../lib/platform/relation-evidence-snapshot.ts) `relationEvidenceColumns:11` | 保留原列序和 native cells，供已选原 payload、证据及 fingerprint 使用 |
| collection replay 与原输入恢复 | [collection-target-replay.ts](../../lib/platform/collection-target-replay.ts) `targetReplaySource:108`、`writeCollectionTarget:159` | 普通完整 replay、reference reuse 都要保持原 capture，不补写旧结果 |
| 当前离线 catalog 与 completed replay | [legacy-provenance-catalog.ts](../../lib/platform/legacy-provenance-catalog.ts)、[legacy-provenance.ts](../../upgrade/legacy-provenance.ts) | 当前 71613，completion 是 collection-legacy-provenance-v1；不是本 capture 已安装的证明 |
| 原档与 alias 不可变性 | [0048 migration](../../db/migrations/0048_cute_madelyne_pryor.sql)、[target-archive.ts](../../lib/platform/target-archive.ts) | 原 collection ref 不重开、不新增字段或换档，不改变 query/relation namespace |
| 被排除的 DTO | [target-relation-display.ts](../../lib/platform/target-relation-display.ts)、[query-history-target.ts](../../lib/platform/query-history-target.ts) | 前者明确 DISPLAY-only，后者是历史入口；两者都不是 reconcile decision adapter |
| 正常服务与决定写入 | [platform-reconcile.ts](../../server/utils/platform-reconcile.ts) `runPlatformReconcile:581`，[collection-import-target.ts](../../server/utils/collection-import-target.ts) | B 显式注入目标接缝；保留 getComparison 和统一导入预检、提交、回执 |

### 1.1 既有原始归档输入的证据上限

本次只读检查 [平台响应摘录说明](../../tests/fixtures/platform/README.md)、[申报原响应摘录](../../tests/fixtures/platform/apply-list.json)和三份 business-list HTML 摘录。README 记录用户于 `2026-10-15T17:11:21Z` 在已登录浏览器代取的四个 HTTP 200 响应。这些是裁剪摘录，不是整份原档；其中 apply grid 的 page=1、pageSize=50、maxCount=2，HTML 外壳的分页数字与内嵌 grid 也不能混用。`rendered-table.html` 是合成输入。

这些已存在的 bytes 只能支持 parser 输入形态的静态核对。它们本身没有 `legacy-slot-pages/v1` 封套，也没有某一真实 query 的全部 relation 行，不能据此宣称 freshStoredSlots 或正常服务已复用成功。README 所指 whole archive 不在本 checkout，本轮未复制或重建。现有 [typed 旧槽测试源](../../tests/platform-reconcile-io.test.ts)和[分页测试源](../../tests/platform-slot-pagination-job.test.ts)只作为已有构造/断言的静态依据，均未运行。原输入路径、大小和 SHA256 记录在证据 root，文件不重复归档。

### 1.2 漏捕获与表示缺口

| 情况 | 已有契约要求 | 本次判定 |
| --- | --- | --- |
| 原页、原 rawResponse、原 relation 与 typed 类型 | 主契约要求原 bytes、页事实、别名和完整采集 | 旧契约已要求。T04 没有读取 rawResponse 专用封套，是此 producer 的漏捕获。不能将归档存在等同于结构化准入已完成 |
| 每观察 stored/source/conflict，含 verified version | 主契约与 T05b 已有本源 observation 分支 | 已有表示，复用该 owner。version 投影只能表达共享内容，不能代替本观察的 stored 比较值 |
| requestCount、各页 queriedAt/raw 原文认证、ordered JSON.stringify 行相等 | collection/page 没有这些原 validator 的全部输入；现有完整性来自不同 evidence owner | 真正的表示缺口。增加专用验证结果及原输入绑定，不能仅把 general completeness 改成 complete |
| 旧 typed payload 的 null/空 object/原 cells 合成 | 原档与 legacyRowSnapshot 已保留原输入 | 不增第二份原文。只在选定 capture 后恢复旧 payload，不能用它重算运行准入或分类 |
| 已 seal collection 追加 capture | 原 ref 集不可追加，T04 digest 包含 collection 全列 | 是生命周期缺口，不能沿旧 transform 静默改变 schema 或 checkpoint；见 §5 |

静态可构造的反例是 rawResponse 有合法完整 legacy 封套、collectionEvidence 和 supplement 均无值：旧 reader 有机会接受，现 T04 的 parseState=absent/completeness=unknown。这里“有机会”仍要求原行、状态和时间同时通过；本轮没有运行此反例。

## 2. 保持原服务的准入顺序

1. 在同一同步 read transaction 中，以 queryKey 原值选 collection 和 public query alias。先按旧 JS `b.queriedAt.localeCompare(a.queriedAt) || b.id-a.id` 排序，再按 interface/rdjb 取第一条。不能以 SQLite 默认排序替代而未证明等价。
2. 每槽在检查 status、freshness 或 capture 之前即标 seen。最新 failed、partial、not_queried、unknown、过期或不合法封套遮住较旧 complete。四个槽之外的接口不产生第五个可复用槽。
3. 只允许 status=success/no_record。freshness 保留 JS 字符串 `queriedAt >= cutoffIso`，cutoff 仍由原 frozen now/freshnessMs 得到。不读 lastCollectedAt，不用 Date.parse、title 或 enterprise assignment 过滤查询。
4. 消费 §4 已捕获的 verified 结果，按原规则检查 no_record 与观察数为零严格对应。missing/error/uncaptured 的行为见 §4。不借 scope/fullRange、row rdjb、generic history、display 或其他 collectionEvidence 证明旧槽完整。
5. 按原 sequenceNo 排序读取该采集全部观察，无版本、未确认、无业务 key、无企业归属均保留。分类事实来自每观察本源投影，payload 原输入按 §3 恢复。它们和 capture 在同一 snapshot；可变 assignment、版本最新指针不影响原采集选择。

alias 是 `platform_legacy_query_alias.old_id`，不是 physical collection.id。同时间的 alias 较大者胜出。relation alias 同样只解析为原 observation，不改 idempotency、sourceRef、决定或历史回执中的外部 ID。

## 3. 旧封套认证与三种行表示

### 3.1 完整验证谓词

capture 边界以原 rawResponse、原 query meta 和旧有序字符串行调用 `readCompleteLegacySlot`。下表逐项冻结现有实现，不增加“更合理”的限制。

| 层次 | 原检查 |
| --- | --- |
| 封套 | JSON.parse；kind 精确等于 legacy-slot-pages/v1；completeness=complete；unfinished.length 为 falsy；failureReason 为 falsy；interface、rdjb、queryKey、queriedAt 与 meta 严格相等 |
| 请求与时间 | pages 非空且不超过100；requestCount 为 safe integer，pages.length ≤ requestCount ≤100；Date.parse(completedAt) 必须 finite，原拒绝条件 `Date.parse(completedAt) < Date.parse(meta.queriedAt)` 必须为 false；不额外要求 meta.queriedAt 可解析，也不以此日期解析替代 freshness 字符串比较 |
| 每页 | status=success、error 严格为 null、page 严格为 index+1；source 为 businessList 或 queryList；rdjb 为 meta.rdjb 或 null；页 queriedAt 可被 Date.parse；已有 total 且 collected 已等于 total 时不再接受下一页 |
| 页原文 | 对正确 grid 调用 parsePlatformPage，按 validateLegacyPage 验证 responsePage、responsePageSize=50、最多50行、声明总数与每页期望行数。缺 metadata 不猜值，合法原 number 或数字 text 的 parser 行为保持 |
| 声明与行 | parsed.declaredTotal 与封套该页声明严格相等，fetchedCount 与 parsed.rows.length 严格相等；总声明、收集总数相等；`JSON.stringify(collected) === JSON.stringify(rows)`，包括行序、own key 次序和旧字符串 projection |
| 外层服务 | status 只能 success/no_record，且 `(status==='no_record') === (rows.length===0)`；旧 query.failureReason 独立保留，不新增外层 failureReason 必须为 null 的条件 |

原实现 catch 后返回 null 的封套问题仍是 miss，不升级为完整查询无记录。不能把该函数当作比源码更严格的全量 shape schema。例如它没有强制 unfinished 是 Array，也没有要求页时间单调或 maxPage/nextPage 满足 queryBusList 政策。B 不得偷偷收紧这些条件；遇到原 reader 本身会抛出的 ORM rawFields decode 错误须保留错误行为，不能吞成 miss。

### 3.2 行输入与 owner

| 表示 | 精确生成规则 | 允许用途 |
| --- | --- | --- |
| typed payloadRows | 原 `storedRawFields`：非空 own-key rawFields 对象原样使用。否则依次按原列合成 id/qymc/tyshxydm/szsfmc/cszt/whpc/sblx/sqsj/personuuid/year，保留原 truthiness 与 year!=null 后 String(year) | 已选原写入输入、payload/replay/hash 认证。不得用旧字符串 projection 覆盖原 typed archive |
| 旧 legacyRows | 对 payloadRows 依次 Object.entries，null/undefined→空串，number/boolean→String，其余非 string→JSON.stringify，以原 `{}` assignment 写入 | 只供页原文有序行认证，以及现有 payload producer 的 legacy 映射。own `__proto__` 在此 projection 的特殊行为保留，不扩散到 typed payload |
| ReconcileQueryEvidence.relations | normalizePlatformRelation(interface, 原 archived relation)，七个比较字段和 normalizationConflicts，加原 sequence/key/name/uscc、sourceKind、typed rawFields | 分类与决定。不得先从 typed payload 字符串化后重算 stored/source 对照 |

number、boolean、null、object、array、own `__proto__`、own `constructor`、对象 key 次序和数组次序在 typed payload 保留。canonical 内容 hash 的排序规则不授权改变旧 JSON.stringify 行相等。空对象不等于 null；旧 storedRawFields 的合成条件也必须保持。

七字段为 province、status、batch、declareKind、appliedAt、awardBatchLabel、year。stored 字符串 trim 后空值为 null，declareKind 使用原字典，source 使用 processFactsFromRow 原类型语法。双方非空且严格不等时，reconciled 为 null，conflict 保留两值；只有一方非空时使用该方。本源 observation 投影的 stored*/parsed*/reconciled*/conflict 直接承接这些事实，不能从 version projection 或当前 assignment 补值。B 必须证明现有迁移和新写物化后的结果与旧实际存储吻合。

分类中的 sequenceNo、relationKey 来自原观察，nameRaw/usccRaw 来自保留原行身份的 revision1，不能换成企业现名或 current assignment 的值。原 alias、sourceKind 与 interface 对应关系保持；后续 assignment 只影响其原本拥有的归属行为。

business status 使用已有 native BLOB 分支，空 BLOB 也不是 null，与非空 parsed TEXT 保持严格冲突，参见 [status 契约](legacy-stored-status.md)。不得为本票另造 status 字典或抹除 #760 的原 FAIL。

原 rawFields 缺失或空对象而触发的旧 payload 合成，允许在**选中采集之后**以原 legacyRowSnapshot 的 native cells 恢复同一原输入。它不能决定 capture、freshness、normalization 或资格；这些都已由结构化 capture/本源投影决定。没有原档不能用 canonical version、display 或 archiveJSON 猜补原 payload，须报原输入不可用。

## 4. 最小表示与运行读取

### 4.1 方案比较

| 方案 | 保真与生命周期成本 | 决定 |
| --- | --- | --- |
| rawResponse 解码作 runtime completeness fallback | 能重复原验证，但业务准入继续依赖 JSON 原档，绕开结构化迁移 | 拒绝 |
| 把 raw 封套页覆盖到现有通用 page/completeness | 可补部分字段，但会改变 evidence/supplement 优先级、页 owner 和已捕获 scope/position；仍缺页原文认证及 typed 行相等 | 拒绝 |
| 完整另存封套、每页及每行复制表 | 能表达，但重复原档、页集合与行身份，增加 alias/replay 维护 | 不采用 |
| collection 专用验证结果，引用已 seal 原 rawResponse；原输入与页留原档，本源投影继续拥有分类事实 | 能固化原完整性谓词，又不更改通用页范围与业务字段 | 推荐，并作为本 A 候选的具体选择 |

### 4.2 字段与约束

在现有 `platform_collection` 增加以下专用列，不新增业务表，不扩 archive ref 的固定 field 集。逻辑值必须在 shared target 声明中有显式 discriminated union，不能把 nullable 字段袋直接暴露给 service。

| 列 | 类型与含义 |
| --- | --- |
| reconcile_slot_state | TEXT NOT NULL，uncaptured / verified / miss / error，默认 uncaptured |
| reconcile_slot_rule | TEXT nullable。verified/miss/error 固定 `legacy-reconcile-slot-v1`；uncaptured 为 null |
| reconcile_slot_raw_archive_id | INTEGER nullable FK RESTRICT。绑定同 collection 已 sealed `rawResponse` ref 的 archive，包括原 SQL NULL 的 archive row；不是新增或改绑 ref |
| reconcile_slot_row_count | INTEGER nullable，safe 非负。verified 时等于原全部关系行数；miss/error 若无法读出全部行则为 null，不用0冒充 |
| reconcile_slot_input_sha256 | TEXT nullable，认证边界用的输入摘要，见下文。不替换任何原 hash 或 requestHash |
| reconcile_slot_reason | TEXT nullable，uncaptured/miss/error 的原因；verified 为 null。reason 是诊断，不是第二套可复用白名单 |

verified 需要 rule、archive ID、count 和 input digest 非空；miss/error 需要 rule、reason 和可获得的原绑定；uncaptured 不带认证摘要。recognized collection 保留 uncaptured/not_legacy_slot 原因，不参与服务四槽。原 SQL NULL raw 有 ref，捕获为 miss；ref 不存在或所属 owner 不明是 uncaptured，不能补一条伪 NULL 档。schema/capture 未安装或未完成是 target NOTREADY，不能降级旧表或假装四槽都 miss。

输入摘要固定为 SHA256 UTF-8 JSON.stringify 的如下有序 envelope：

`{rule,query:{id,interface,rdjb,queryKey,queriedAt},rawResponse:{storageClass,byteLength,sha256},relations:[{id,sequenceNo,rawFields:{storageClass,byteLength,sha256},fallbackCells}]}`

id 使用原 public query/relation alias。relations 按旧 sequenceNo 顺序；fallbackCells 总是保留 §3.2 原合成所用列的有序 `{name,storageClass,hex}`，依次 relation_key、name_raw、uscc_raw、province、status、batch、declare_kind、applied_at、award_batch_label、year。原 raw archive 不经 parse/stringify 计算 bytes hash。缺 ref 是显式缺失标记，不能与 null storage class 共用一个摘要输入。该摘要只绑定这次捕获的原输入，不认证当前 assignment、lastCollectedAt 或版本 current 指针，也不属于旧业务 fingerprint envelope。

捕获完成后 state/rule/archive/count/digest/reason 及其 query 身份上下文不可改。T05a、T05b 和最终完成核对用 alias、原 cells 和原档重算绑定，证明 T04 原关系集确实映射到目标全部观察。新写在全部观察物化后一次完成 capture。禁止在已 verified collection 追加观察改变认证行集；合法 replay 只复用已有集合。单独来源 writer 不能宣布整槽 verified，也不能破坏已有整槽捕获；assignment 追加修订和原 lastCollectedAt 更新规则仍允许。

结构化 verified 结果已经包含原 requestCount、时间、page/raw、声明及有序字符串行认证的结论，因此不需要另存这些字段作第二套运行判定。原页和输入仍能由明确证据 owner 独立复核。运行 reader 只检查所支持 schema、必要列、completion，并消费 capture，不恢复 DDL/hash 信任根或每次整库 manifest 验证，遵守 #744。

### 4.3 snapshot 和归档边界

运行接缝首先用 collection/query alias/capture 选择槽，再用同 transaction 中的 observation 与本源 observation 投影产生分类事实。captured miss 是普通缺槽；captured error 按原 decode 错误暴露；uncaptured 是不可证明的历史输入，不能用 archiveJSON 临时补算，显式目标服务报 NOTREADY。

已选中的 typed payload、原字段合成材料、原页认证和 fingerprint 可由各自原输入 owner 读取原档。读取量限定为选中四槽的必要原输入，不扫描 unrelated archives。原档校验失败是输入损坏错误，不返回可复用的空集合。不得通过通用 display/history DTO 绕过这些 owner，也不将 selected payload 的恢复接缝暴露为新的业务 fallback。

## 5. 离线、新写、重放和恢复

### 5.1 推荐从同一固定源建立新鲜链

本次推荐在全新独立 target 的 expand 完成后、**第一次 T04 schema/transform 绑定前**安装专用 offline prerequisite。它只增加 §4 列、FK 和限定不可变约束，沿用现有 archive/alias owners。普通 expand 和运行 guard 不借此自动迁移。

T04 使用明确新 transform `t04-collection-reconcile-slot-v2`，保留旧 `t04-collection-v1` 的实现与 replay 分支。新 transform 的 source manifest 额外覆盖所有参与捕获的 relation PK、sequence、rawFields 及 fallback cells；原 T04 manifest 只涵盖 query/provenance/scope/error，不足以绑定新输入。schema、输入 manifest、transform、每批 capture/digest/checkpoint 在各自原事务中绑定，未认证行不推进 cursor。所有失败输出保留。

T04 在原 frozen schema0 source 上读全部该 query 关系行并验证，写入原 rawResponse archive 后把其 ID 与结果同时持久化。T05a/b 负责原观察映射和本源比较事实；它们的 binding/target catalog 只在新 run 建立时接受明确 capture variant，不能重写旧 receipt。实际后续离线各阶段必须识别并保全此 variant，最终到当前 71613 和原 provenance completion，再额外记录本 capture 全覆盖 completion。捕获 completion 使用现有 run/checkpoint owner，transform 为 `reconcile-slot-capture-v1`，只覆盖本链固定历史集；不新建命令 ledger。

最终 readiness 为明确支持的71613 + 本 variant 必要列/FK + 原相关迁移完成 + capture completion。不能只看到71613就通过。新 target catalog、typed schema、archive owner inventory 和所有实际经过的 offline 工具必须纳入 B1 的兼容核对；若此边界超过 ≤M，应报告具体不兼容 owner，再由父级调整拆片，不能缩减验收。

这项新鲜链选择避免在已绑定 run 上改变 target schema。它不声称现有工具已支持该 variant，不保证只改一个 helper 即能全链通过。专用列不进入原 query/observation/version hash、source snapshot 原值、历史工作簿或既有 reference 的 envelope。

### 5.2 已完成与中断绑定

| target 状态 | 本候选的处理 |
| --- | --- |
| 旧 T04 running 或后继 running | 仍用原 snapshot/schema/manifest/transform/checkpoint 续跑。新实现不得趁 resume ADD COLUMN、换 transform 或沿用旧 cursor 捕获新输入 |
| 旧 completed71613，尚无新提交 | 保留原件和全部回执；若要本能力，从**同一个原固定 schema0 snapshot**创建新 target/new run。不得重新备份后冒称同一 snapshot |
| 旧 completed71613，已有新写、补录、决定或 receipts | 本候选不原地升级，不用旧 snapshot 覆盖它。维持原服务边界，本 capture target admission 为 NOTREADY。须有实际需求与原件证据，父级才另行裁定保留新写的增量方案 |
| 新 variant 中断 | 同一 snapshot/new run/transform/catalog 绑定重试，事务失败不留半批；不能切回旧 transform 强行继续 |
| 新 variant 完成，之后有合法新写 | exact completion replay 只检查本 run 历史 capture 和绑定，不要求总行数回到原 manifest。新 collection、观察、assignment、supplement 和 receipts 全部保留，不给新行补历史 capture |

不预设71614。仅为兼容一个未授权的旧 target 原地升级而增加 successor，会扩大本票生命周期。若父级确实要求这种能力，须先给出已完成库与新增提交的固定输入及无损验收，再独立决定 successor；不能在 B 中悄改本表。

### 5.3 新写与 replay

`writeNewCollectionTarget` 同事务保存原 rawResponse 和 evidence、分配 public alias、写全观察及其来源投影，再按**旧实际插入物化后的字段**完成捕获，最后 caller 提交原 receipt。以原命令直接认证后忽略 trim/null/INTEGER 物化，不能证明未来旧 readback 相等。裸 success、failed、partial、无页原文都可以继续保存原事实，但 capture 为 miss，不伪造完整性。

普通 `writeCollectionTarget` 完整 replay 和 reuse/reference 命令先保持原 payload/source 冲突检查，再核对原 capture 输入及结果；不修写 miss，不重新分配 alias，不新增原观察，也不改变原 query.queriedAt。原同内容复采 lastCollectedAt 行为保留。运行 reconcile 复用仍使用 raw 为空的旧 sentinel 和原 typed rows；不得为通过新写 gate 而把原完整封套重新提交为第二次查询。

新采集取得的 legacy rows、typed payload 与旧 producer 行为继续分别处理，本票不扩大 fresh transport typed 政策。两来源 source writer 的独立调用可维持未完成 collection，但不得让未捕获 collection 被 reconcile 复用。recognized writer 不获得旧槽准入。

### 5.4 恢复

新鲜 prerequisite/T04 批次、观察和 capture 失败都回滚当前事务，使用同一固定源按原绑定重试。未开放写入时，可丢弃失败 target，从同一固定 snapshot 建新 target，保留失败证据。

已开放新写后，保留当前 target、原档与新 receipts，用支持该 variant 的二进制前向修复。禁止用 predecessor 备份覆盖新提交。本票不提供逆迁移、旧 binary 打开新 target、生产切换或 rollback 到旧 schema 的授权。同 snapshot 回滚重试与后继写入保全均须 B 实测。

## 6. B 的可执行接受矩阵

下面全部为 **runtime UNRUN**，不是 A 的 PASS。B 用一份由真实 offline 工具构造并冻结为 readonly 的迁移 fixture，按 case COPY 到独立可写文件；不逐 case 重建全链，不修改共享依赖或 fixture 原件。旧 schema0 service、目标和 literal 预期共用同一 frozen time。正常路径必须真正调用 `runPlatformReconcile`，不能只调用 helper 后宣称完成。

| 编号 | 必须验收的行为与独立预期 |
| --- | --- |
| B01 原 producer 正常链 | 通过真实 `queryPlatformSlots` 和原统一导入路径生成合法封套及存储行，用本地 replay fetch，不走真实网络。真实 schema0 service 与 literal 行集/状态预期一致，再以同一固定源运行实际新鲜 T04→71613 链；独立核对 alias、原 cells、archive bytes、hash、history 和 capture |
| B02 四槽 no-fetch | 四槽 fresh，取消环境凭据、显式无凭据，fetchImpl 抛错。实际 runPlatformReconcile 报 network=0/reused=4，cookie 不因全复用而读取；分类与旧 service/literal 一致。检查真实调用计数，不能只信报告字段 |
| B03 最新遮挡与排序 | 较旧 complete、较新 failed/partial/unknown/stale/miss；最新先遮挡，不能回退。queriedAt 相同但 public query alias 与 physical collection ID 顺序相反，仍按 public alias。字符串时间与 Date.parse 顺序不同的边界单独验证 |
| B04 freshness 与身份 | cutoff 相等、前后各一值；只更新 lastCollectedAt 不使旧 queriedAt 新鲜。不新增 title/enterprise 筛选。三 business 槽与 apply 空 rdjb 分离，recognized 不参与 |
| B05 页与原文 | 1页、50/51行多页、连续页、声明变化、缺页/重复页、pageSize非50、请求计数越界、completed/page 时间、failureReason/unfinished、原页 parsed 行与有序字符串行不等。每项 literal 预期与真实旧 service 一致，保留原严格等号和原异常 |
| B06 空、失败与缺失 | 完整空封套+no_record 可复用；success空、no_record有行、bare success 原单页 raw、missing、failed、partial、stale 不复用。缺槽分支用本地 replay fetch 与假凭据，仅补缺槽，真实外网请求为0 |
| B07 typed 与 fallback | number/boolean/null/object/array/own __proto__/constructor/key顺序；typed 原行/hash 不被字符串化。原 rawFields=null、空object与原列合成保持旧行为。缺原档报不可用，不能 canonical/display fallback |
| B08 逐观察比较 | 同一 version 的两观察 stored/source 冲突不同、无 version、无业务 key、未确认或 assignment 后续改变仍保留全部行。七字段的原 trim、declareKind、year 类型与 native status BLOB/空BLOB 与旧 service/literal 相等；不走 version-first |
| B09 实际决定写入 | 真实运行分类、统一预检/提交/回执与重复 replay。决定、来源引用和 idempotency 与旧预期一致；复用四槽不增原 collection/observation/version，不覆盖 bytes/alias/queriedAt。首次 replay 允许的版本补齐仍按原规则分别核对 |
| B10 snapshot 与 SQL | 捕获选择、分类事实、typed payload 来自同一同步 snapshot。用独立连接改变 current version/assignment，观察结果不混读。SQL trace 证明目标分支不读取旧 platform_query/platform_relation；原档读取仅在选中后进入指定 owner |
| B11 失败与绑定 | 在 capture/批次/checkpoint/完成前注入失败，原 cells 和日志无半提交。用同 snapshot 同 run 重试；变 source/schema/manifest/transform/cursor 均拒绝。旧 running 不被新代码自动改绑；旧 completed71613 不被安装新列或重写旧 receipt |
| B12 完成重放与后继写入 | 新 variant 完成后正常新增 collection/观察/决定/assignment/supplement/receipts，再完成重放，历史核对通过且新增数据无损。漂移历史 capture 拒绝。旧 completed 原 replay 仍按原边界；不以全库当前 manifest 等于历史 manifest 为条件 |
| B13 CLOSED 与排除域 | schema0 原路径保持；显式71613缺 capture variant/completion 报 NOTREADY，不静默 fallback。不扩大普通 db/import/worker/jobs guard，不接 #738–742、current reader、网络政策或 DROP/prod |

## 7. A 要求矩阵和后续 ≤M 边界

| A 要求 | 本文位置 | 本次证据 |
| --- | --- | --- |
| 实时票面、固定 cwd/base/tree、仅本地 docs | 文首，仓外 invocation/静态报告 | gh read 与 git 静态核对；没有 tracker mutation |
| 原 producer/validator/typed/normalization 与全部目标 owners | §1、§3 | 固定基线源码逐项静态核对 |
| 漏实现和表示缺口、方案选择 | §1.2、§4 | 明确选择 collection 专用结果，未把静态反例冒充正常路径 |
| 字段、原输入及 alias、逐观察事实 | §2、§3、§4.2 | 表示契约候选，尚未安装 |
| 离线/新写 capture 和原 T04/completed/interrupted71613 | §5 | 新鲜 prerequisite 推荐、旧绑定不变；不预设 successor |
| 正常路径、写入、replay、恢复与新写保全 | B01–B13 | 全部 runtime UNRUN |
| pending 接受、排除域、≤M 拆解 | 本节与 ADR/主契约指针 | A 候选只待父级 review；B 未授权 |

父级接受 A 后，B 按以下实际依赖推进，不按 helper 开票。任一片超出此边界即带具体 owner/反例返回父级拆分，不把边界外工作混入。

| 片 | 级别、难度、依赖 | 独立交付与验收 |
| --- | --- | --- |
| B1 离线 capture 与绑定 | ≤M 候选，高难度；依赖 A 接受及父级单独授权 | 专用 schema prerequisite、新鲜 T04 variant、相关 offline catalog 保全、T05观察映射核对，沿真实链到71613。B01、B05、B07、B08、B11 及 B12 历史 completion 部分独立可审可验。不得提前切运行消费者 |
| B2 新写与 replay 生命周期 | ≤M 候选，高难度；依赖 B1 固定候选接受及父级单独授权 | collection 事务、两来源 writer 的完整性保护、物化后捕获、完整和 reference replay、后继写入与完成重放保全。以真实 writer/统一导入完成 B07–B09、B11–B12 的写入部分；不切 reconcile |
| B3 reconcile 显式目标接线 | ≤M 候选，高难度；依赖 B2 固定候选接受及父级单独授权 | 专用 target decision adapter、旧服务接缝与实际统一导入调用，保留 schema0 和原 getComparison；完成 B02–B04、B06、B09、B10、B13 及全矩阵正常路径。目标仅通过显式注入，global guards CLOSED |

正常 `runPlatformReconcile` 还会调用 getComparison 收集目标。其 target current reader 由父级并行工作提供，本票不实现它。若固定集成候选尚不能让该正常入口全程不读旧表，B3 正常路径验收为 NOTREADY；不得用 helper、替身 getComparison 或绕过目标收集的调用签下 B02/B10。

current reader、资格 #738–742、getComparison 政策、网络重试/凭据/pageSize 政策、worker/jobs/global cutover、DROP、真实业务 DB、prod 不属于本票。父级安排独立 Standards/Spec review、LOCAL 接受和后续 B；本代理不启动 children、review loops、push、PR、tracker 写入或 primary/main 修改。

本次 fresh 证据仅为源码、已有输入、链接/hash、要求覆盖及 diff 静态核对。fixture 生成、DB 打开或迁移、runtime、tests、typecheck、build、正常 runPlatformReconcile、HTTP/MCP、真实联网和生产均 **UNRUN**。既有 PASS/FAIL 是历史证据，不进入本轮 fresh 结果。
