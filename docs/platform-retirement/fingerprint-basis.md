# 观察 fingerprint 输入保全契约

状态：[#723](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/723) docs-only 候选，待独立审查。此文补充[退役契约](contract.md#不可变归档与引用)，设计理由见[ADR](../adr/2026-11-11-observation-fingerprint-basis.md)。不是已实施 schema，不接受 #722 候选。

## 索引证据 owner

规划表 `platform_observation_fingerprint_basis` 仅存以下字段。它是观察索引证据的专属 owner，不增加 generic 表或业务字段。

| 字段 | 约束与责任 |
|---|---|
| observation_id | 正 safe INTEGER PK，FK → 最终 platform_business_observation.id，ON DELETE RESTRICT；为 basis-first 原子插入使用 DEFERRABLE INITIALLY DEFERRED FK |
| scheme | NOT NULL，限 legacy-indexed-v1、legacy-bootstrap-v1、target-command-v1、uncaptured |
| input_archive_id | nullable UNIQUE FK → platform_archive_value.id，RESTRICT；三个 captured scheme 必须非 NULL，uncaptured 必须 NULL |

captured 由 scheme 三分支表达，不另加可矛盾的布尔列。PK 支持按观察查证，UNIQUE(input_archive_id) 防本表共用；不增业务查询索引。表在 INSERT 时即封存，禁止 UPDATE/DELETE/换绑。BEFORE INSERT 显式拒绝 observation_id 或非空 archive ID 冲突，涵盖 recursive_triggers=OFF 的 REPLACE 与 upsert。未知 scheme、SQL NULL 输入档案、非 BLOB 输入、缺档或未提交 owner 均拒绝。BLOB 是 canonical UTF-8 bytes，不是 SQL NULL 原文的替代。

原三 ref 仍只允许原 field 列表、原 0→1 seal。basis INSERT 检查 collection/observation/version 三 ref 的全部 archive_id；反向三个 ref 的 INSERT 检查 basis.input_archive_id。不能只加单表 UNIQUE。三来源 projection.source_archive_id 必须继续指其 observation sealed rawFields；version.canonical_archive_id 必须继续指其 sealed canonicalRawJson。这些二次引用不变成独立 owner，也不得指 basis。新增 schema 工具须枚举全部 archive FK 和触发器，未知引用 owner 拒绝，而不是只凭此列表放行。输入 archive 不去重，即使与 raw 或别的 basis bytes 一致。

archive 自身保留 INSERT-only、长度和 SHA256 校验、64KiB 分块读取。basis 不进入业务 membership、资格、分页、归属或范围筛选；只有按明确 observation owner 核验历史指纹时读取。

## 原算法与原 bytes

`target-command-v1` 同时覆盖完整 collection command 和直接 source writer。保存的是原 writer 实际消费的：

```text
canonicalPlatformJson({collectionId, position: input.position,
                       row: input.row, assignment: input.assignment})
```

以同一个 UTF-8 buffer 写 archive、计算 SHA256。不能用 Zod clone、DB insert DTO、normalized row 或当前 assignment 重造此对象。必须保留原 own keys、omitted/null、数组次序、类型和 extra own keys。原 serializer 仍拒绝 undefined、函数及其他非 JSON 值。scheme、basis ID、archive ID 不进入原 envelope。不得改写已有 input_fingerprint、projection_rule_version、contentHash、原 raw/source/request bytes 或 indexedAt。

`legacy-indexed-v1` 与 `legacy-bootstrap-v1` 使用原 public oracle 的同一 envelope，差别只在有据的首次索引事件：

```text
rawText = 原 raw_fields 的 SQL TEXT 值或 SQL NULL
rawFields = null
try: rawFields = rawText === null ? null : JSON.parse(rawText)
catch: 保持 null
input = {interface, relationKey: 原 source_relation_key,
         queryId: 原 query namespace alias, sequenceNo: 原 sequence_no,
         queryKey: 原 collection.query_key, rdjb: 原 collection.rdjb,
         queriedAt: 原 collection.queried_at, rawFields,
         invalidRaw: rawFields === null ? rawText : null}
bytes = UTF8(canonicalPlatformJson(input))
```

SQL NULL、文本 `null`、非法 JSON 分别产生 `invalidRaw:null`、`'null'`、原非法文本。合法 primitive/array 不改类型。先按迁移 cells/manifest 验证 storage class、原字节与原坐标，不能把错误解码后的替代字符当作原文本。对于不符合原 oracle 可重现范围的 BLOB/非法 UTF-8，保存原档并报告不可核验，不伪造 TEXT。legacy 不加入当前内部 ID、page position 或 assignment。原 hash 已有时必须比较相等才登记 captured，不能以新 digest 覆盖它。

## 生命周期与恢复

生命周期由本次原子索引事件，或独立冻结 source、迁移 manifest、原调用证据与 checkpoint 证明。request 存在、projection rule 字符串或尝试两种 hash 哪种命中，都不构成生命周期证据。

| 分支 | basis 与动作 |
|---|---|
| 新 target capture | 三源 writer 在同一 savepoint 捕获实际 canonical 输入并写 target-command-v1；包括无 record/version 的观察，不以身份成功为前提 |
| legacy indexed/backfill | 冻结旧源证明原 indexed 状态，alias、cells、raw、坐标、原 rule/hash 全部相符，追加 legacy-indexed-v1；保留原索引时间及所有旧事实 |
| paired not_indexed | record/version/keySource/rule/fingerprint/indexedAt/batch 保持真实 NULL、双 not_indexed；无 basis，不把它标成无法恢复的 indexed |
| 首次 ordinary full-raw bootstrap | 原来源 owner 完整、原载荷验证通过，第一次补索引时写 legacy-bootstrap-v1 与真实本次 indexedAt；同时原子写 basis。即使 collection 有 request，也属于此分支 |
| explicit reference 指向 not_indexed | 不 bootstrap，不造 hash、basis、record 或 version；保持原引用规则 |
| 已有 command-indexed，有可信完整原调用 | 完整输入可绑定具体 observation/collection 与原事件，保存所有 own keys/position；canonical bytes 对原 hash 相等，原投影与 revision1 相等后才可 backfill target-command-v1 |
| command-indexed 仅 request+typed facts | 一般不可恢复，追加 uncaptured；保留观察、hash、档案与失败 checkpoint，拒绝 fingerprint 认证 |
| 生命周期不明或原 source/alias/bytes 冲突 | 拒绝迁移认证，保存逐行原因；不能用 digest 命中把未知事件改称 legacy/bootstrap |

恢复 manifest 逐行记录 observation、旧 alias、scheme 或 uncaptured 原因、独立来源指针和验证结果，并绑定新 phase receipt。原始输入缺失与原事实冲突分别报告，不能混成 absent。只对证据充分且验证通过的行登记 captured。未知真实库数量、覆盖率保持 UNKNOWN，本票不扫描真实库。

uncaptured 是封存结论，本表无 UPDATE 修复口。若之后找回可信原输入，另行授权离线重建新的隔离 target，并保留旧 target、原 hash 和证据；不能 REPLACE uncaptured 或删除历史。只有有保留的原调用或冻结旧源时才可重建。重放新输入只能证明新 target，不证明旧 hash 历史已恢复。真实历史缺失时阻塞后续接受，不能以抹掉 target 解决。

## 双向验证与 assignment 修订

认证须在同一读取快照完成以下检查，不能只验证 archive 摘要：

1. 由 typed collection/observation 与 namespace alias 确定 owner，验证 basis FK、scheme、archive 独占性、BLOB 长度和 SHA256。比较 canonical bytes 的 digest 与原 input_fingerprint，检查原 PLATFORM_PROJECTION_RULE。unknown/uncaptured/缺 basis 一律 fail closed。
2. 输入向事实核对：按原 scheme 和原 writer 持久化规则，检查 collection ID 或旧坐标、position/page 所属、source key、raw/source 原档、三源 observation projection、record/version 映射。target row.rawFields 的 JSON.stringify 原结果须与原 raw 档相符，sourceText 按原 nullable 规则核对；legacy raw/cells/manifest 原字节独立相等。
3. 事实向输入核对：把当前同 owner 的原事实按该 scheme 投影，与已保存输入的相应值比较。覆盖全部已持久化字段，不能遗漏额外一条原档绑定、缺少 projection owner 或错 query/relation 配对。输入中数据库未保存的 optional 存在性与 extra keys 由已封存输入证明，不能枚举省略/null 组合倒推。
4. target-command 的 assignment 与 revision1 按原 DB 持久化规则比较，包括 origin、actor、basis、recordedAt、commandReceiptId 及 nullable 原值；原 row 中另有 assignment 断言时也须验证原规则。更晚 revision 不进入原 hash。legacy envelope 不含 assignment，revision1=migrated_current 仅证明迁移时归属，不伪称原索引时归属。当前归属继续读取最大 revision。

source projection 仍按三个来源原 parser、规则版本与 conflict 语义核验，不用 latest shared version 代替 observation owner。正常 assignment revision2+ 不触发原输入漂移，revision1 或原坐标漂移必须拒绝。basis 不能独自证明全部 mapping：#722 仍须独立按原 plan 检查 identityState/contentState/keySource/rule/fingerprint/recordId/versionId，并保留 source drift 与 mapping conflict 的原边界。

## 独立实施切片与无环依赖

下列是待独立授权的实施切片，不是本票代码，也未创建 tracker 待办。每片 scope≤M。

| 切片 | 前置 | 最窄工作与独立接受条件 |
|---|---|---|
| S：schema/offline phase | #723 契约接受；已接受 71606 结构 | 专属表、全 ref 对称独占、索引写屏障、target 注册、离线 successor/run/checkpoint 与恢复 manifest。独立小 SQLite oracle 覆盖全 FK、seal 不变、REPLACE/upsert、可恢复/uncaptured、DDL/receipt 原子回滚及旧 writer 拒绝。无 runtime 接线 |
| C：capture/replay | S 独立接受 | 三源 writer、完整 command 的实际 bytes capture；ordinary bootstrap 与按 scheme 认证；planned/exact-original 两次 owner 选择、ordinary/reference 均核验。独立原 bytes/hash oracle、三源多对一输入、revision1/当前归属分离、caller-caught savepoint 回滚。不切 public routing |

依赖边只有 `#723 → S → C`，以及已接受 `71606 → S`。C 不要求 S 调用 capture/replay；S 的验收通过独立离线 fixture 完成。S 可停在只读隔离目标，不要求启用业务 writer，因此没有互相阻塞。

#722 的 migrated F1 和完整 mapping F2 是现有拒收项，不是 S/C 的新前置待办。父线程可以先在 #722 自身修复并独立验证 migrated F1、rule 与 F2。对新 command fingerprint 的最终认证须等待 C；禁止先合当前 `3d4ea502...` 绕过这两个拒收项。本票不 cherry-pick 或 merge 其实现。S 只依赖已接受基线；C 可在 S 上完成 reusable verifier，待父线程安排修复后的 #722 消费它。最终接线候选必须同时包含 F1/F2 修复与 C 的输入验证，接受顺序不把 #722 变成 S/C 的反向依赖。

### S 的 phase 与旧 writer 屏障

规划离线 successor 为 71607，transform `observation-fingerprint-basis-v1`。实施时先核号未被占用；不得复用 71606 或改写其历史 receipt。仅接受完整 71606 一致副本，冻结 source 与 target 的 DDL、全部原事实和 hash bytes，检查 predecessor receipt/checkpoint 与全 archive FK inventory。S 不重新执行旧 T04/T05 阶段。已有 target 可能有后加 command 数据，须将其完整 after-predecessor 状态纳入 manifest，不冒称已被旧 checkpoint 覆盖；无法证明 predecessor 及新增事件来源时拒绝认证。

一个 FK-ON immediate 事务安装新结构、分类恢复历史、安装写屏障、核对双向原事实不变、写 successor receipt/checkpoint，最后推进 phase。失败连 DDL/trigger/marker/receipt 一并回滚，保留失败副本及证据。重启只重放本 successor 的 source/schema/transform/完整目标 manifest 绑定，不能修改旧 receipt 让旧阶段在新 schema 重跑。

屏障必须在 S 交付就生效，不能等 C 才补。具体采用 basis-first：新 indexed observation INSERT 要求同 ID 已存在 captured target-command basis；paired not_indexed→indexed UPDATE 要求同 ID 已存在 captured legacy-bootstrap basis。普通新写不能插 uncaptured，不能以 legacy-indexed 冒充新 capture；这两种历史分类只在离线升级安装屏障前执行。basis FK 延迟至 commit，允许新 writer 在同步事务内先分配安全 observation ID、写 archive/basis，再插 observation。C 必须显式安全分配 ID，保持 sqlite_sequence 高水位与回滚，不改旧 ID/alias。在写连接持续开启 foreign_keys 的前提下，basis 的 deferred FK 在最外层 COMMIT 检查并拒绝孤儿；嵌套 savepoint 的 RELEASE 不代表此检查已通过。basis 存在性 guard 阻止无 basis indexed 提交；既有 indexed 原字段仍不可借本切片改写。

旧直接 writer 即使绕开 phase 检查，也因其未写 basis 而在 INSERT/首次索引 UPDATE 被拒绝，嵌套 savepoint 回滚其先写内容与 alias。旧 command/replay 只接受 71606，面对 71607 必须拒绝。已存在行的只读旧 seam 不能用作认证入口。普通 expand runtime、初始化与三个 worker 的非零 user_version 拒绝保持，不通过环境 selector 放行。C 接受前 71607 只用于离线验证，所有 target 新提交暂停。

### C 的原子边界与未来验证

S 的离线入口及 C 的所有受支持写入口（含可直接调用的 writer、bootstrap、archive/basis helper 与重放补建路径）必须在任何写入之前读取当前连接的 `PRAGMA foreign_keys`，仅值为 1 时继续，否则拒绝且不产生写入。外层 caller 已开启事务也必须检查，不能在事务内尝试设置 PRAGMA 后假定生效。连接初始化开启 FK 不能替代入口检查；不承诺绕过这些入口的任意 FK-OFF SQL 安全。持有最外层事务的调用方负责 COMMIT 及失败回滚；savepoint 返回只是事务内操作完成，不能作为整体提交成功或认证通过的回执。

archive、basis、observation、assignment revision1、source/version projections、aliases/highwater 在同一个现有嵌套 savepoint 内提交。先保存真实 canonical bytes，再从同一 buffer 计算原 digest；不得留有 hash 无 basis 的新行。bootstrap 先写 basis 再更新原 not_indexed 分支。任何错误即使被外层 caller catch，也须恢复全部 before facts 与分配高水位。重放只能验证同一不可变 basis，不插第二份或偷偷换 scheme。

未来 S/C 的独立验收必须覆盖每类受支持写入口在 FK-OFF（包括外层事务已开启）时写前拒绝、全部 before facts 与分配高水位不变；独立 SQLite oracle 须证明 FK-ON 下未闭合的 basis 可以经过嵌套 RELEASE，但最外层 COMMIT 必须失败，显式回滚后原事实不变，而完整 basis/observation 配对可正常提交。不能将 savepoint RELEASE 的成功当作 deferred FK 验收。

未来 C 的独立验证必须覆盖研究原始 A/B bytes 的 literal hash、extra own key、direct position 省略/null、带 request 的 bootstrap、malformed/null/primitive/array、三源 parser、两次 owner 选择、explicit reference 不 bootstrap、uncaptured/未知 scheme/缺档/坐标与 revision1 漂移拒绝。回放错误保留原 kind、relation alias、code 与 field=`relations`；source/rule/hash 漂移保持 `projection_source_drift`，mapping 漂移保持 `projection_mapping_conflict`。不得以派生 expectedHash 或新实现自身输出作唯一 oracle。

## 回滚和接受边界

S 失败恢复事务前副本，失败证据不清理。S 提交后只允许支持 71607 且持续捕获 basis 的 binary；C 尚未接受或不兼容 binary 回滚时暂停新提交。不能 drop basis、放宽写屏障、降 user_version、用旧 DB backup 覆盖新事实或允许旧 writer 继续无 basis 写入。若必须退回旧 schema，需另行批准保留全部新 collection/observation/assignment/archive/basis/receipt 的逆向方案；本票不承诺此方案已存在。

未改变公开 HTTP/MCP schema、业务资格、其他 fingerprint/113/114 算法或生产切换批准。原 #722 独立 0 PASS/4 FAIL、研究各轮 FAIL、HTTP baseline FAIL、#705/B409 保持原状。研究 v5 8 PASS 仅继承为反例证据。本票所有 runtime/tests/DB/build/安装/真实库/部署均 UNRUN。
