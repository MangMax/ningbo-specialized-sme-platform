# #733 A：认定资格见证输入捕获

状态：实现候选，待父级独立接受。#733 为 scope:L，A 捕获与 B reader 各≤M；本文只交 A。原诊断 `5c0e8eeb` 保持历史。父级确认保留旧 typed SQL，并授权本见证专用 observation 位置捕获；不据此启用公开入口或提前实施 B。

## 输入审计与复用边界

冻结消费者为 `recognized-filter-source.ts` 的 typed SQL 与 `current-qualification.ts` 的见证页定位块。它有两种不能合并的语法：

1. SQLite `json_extract`/`json_type` 读取原 collectionEvidence：支持 SQLite JSON5、重复键取首值；fullRange 的数值1与 boolean true 均满足 `=1`，数值2、字符串1、NULL、缺失不满足。source、evidence status、complete、and 也按原提取值比较。不能把其他域的 boolean `platform_collection.full_range` 偷换成本见证谓词。
2. SQL 提取 pages 后，旧 JS 对该结果再 JSON.parse；外层 pages 取 SQLite 首键，页内重复键取 JS 末键。成功页 fetchedCount 参与原 JS `+=`，含 text 拼接、null→0、缺失→NaN、boolean、负值与 REAL；按数组 ordinal 取首个覆盖 sequence 的成功页，不要求 page_no。JSON.parse 失败为该见证不适用；页遍历错误与未定位不同。

实际旧源→全部既有迁移→#731/#732 的最小反例：`pages:[{success,rdjb:2,count:1}],pages:[]` 的旧见证定位到首数组 ordinal0，既有 page owner 却无任何行；不能虚构 page FK 或改写已接受 page rows。重复 rddqrq 2028/2029 的旧条件为2028，既有 condition 为2029。原 collectionEvidence 为 SQL NULL 且有 supplement 时，旧见证仍不接受，不能用 supplement 自证。

保留并复用：collection 原 interface/status/titleCode/rdjb；当前 assignment 与身份/版本/recognized 保真投影；namespace aliases。它们没有在 A 中转换为资格判定。sourceMaintenanceYearAbsent、false非missing、保真原字符串及 source validity/batch grammar 继续由已接受 owner 和 B 的语义对照负责。

## 完整新增字段矩阵

所有字段前缀 `witness_`，仅显式 successor 注册，普通 `db/schema.ts`/startup migration 不变。已有列、IDs、hash、run/checkpoint、page_id/position_state、candidate mask 不改写。无新业务表。已捕获的三条件新事实禁止更新、删除或替换；BEFORE INSERT 按既有 owner 拒绝 REPLACE；BEFORE UPDATE 在 owner 改变时同样检查并保护目标 owner，不依赖 recursive_triggers，避免通过隐式删行丢失捕获。

| Owner | 新字段 | 类型与含义 |
|---|---|---|
| collection | state, gate | state TEXT NOT NULL DEFAULT uncaptured：captured/error/uncaptured；gate INTEGER nullable，仅捕获完成的 SQLite 证据门槛0/1。它不是 `full_range`，也不包含企业归属/版本/正式资格门槛 |
| collection | rule, archive_id, sha256 | 规则 `recognized-witness-input-v1`；原 collectionEvidence archive FK RESTRICT 与原摘要。真实 SQL NULL archive 有 ID、sha256=NULL；缺 ref 为 uncaptured、archive_id=NULL。BLOB 保留 BLOB，TEXT 在 SQLite 提取前按原 storage class CAST 为 TEXT，避免 JSONB 歧义 |
| collection | error_name, error | 原 SQLite malformed JSON 的错误；缺 ref 单独为 missing_original_collection_evidence。无 supplement fallback，无残留旧表读取 |
| condition | kind, value | 仅 rddqrq/whpcyear/whpc 三行：SQLite json_type（absent/null/text/integer/real/true/false/array/object）与 json_extract 的原 SQLite cell。BLOB affinity 保留结果的 TEXT/number/NULL，不强制转字符串。array/object 的 SQL结果本来就是文本，与旧 SQL一致；其余条件行两列均NULL |
| observation | state | TEXT NOT NULL DEFAULT uncaptured：matched/unmatched/not_applicable/rejected/error/uncaptured，分别为已定位、未定位、证据门槛未通过、原 pages JSON.parse 拒绝、原遍历/取键错误、缺可信原件。不是资格有效/无效 |
| observation | rule, collection_id, sequence_no, archive_id, sha256 | 只绑定本观察的实际 collection/sequence 和同一原证据归档；不按共享 version 转移或扩张位置。archive FK 指原证据，不指不存在的 page row |
| observation | ordinal | 原 SQLite 提取的 pages 数组在 JS 解码后的0基位置；仅 matched 非NULL。与当前 page_id 独立 |
| observation | rdjb_kind, rdjb_value, rdjb_key | 原定位页 rdjb 的 JS kind（absent/null/text/number/boolean/array/object）和值；非NULL值保存 Node v8 serialize 的独立 BLOB（Node24.22.2固定运行时，保留 -0、Infinity、孤立 surrogate 及嵌套值），类型由kind显式区分；未捕获/NULL不伪造bytes（原完整输入仍绑定归档）。rdjb_key 为原 JS truthiness/ToPropertyKey 结果的 UTF-16LE code units 小写十六进制 TEXT（每 code unit 四字符，例如 `2` 为 `3200`，孤立高 surrogate 为 `00d8`；NULL 保持 NULL，空字符串为零长度 TEXT）。这不是 JSON，后续 reader 可用同编码查键或无损解码，不读取原文或 v8 BLOB；该编码保留 SQLite UTF-8 TEXT 无法直接表示的孤立 surrogate。此字段仅作后续按旧语法查表的输入，不存 title 枚举。原值 BLOB 仅证据保真，业务 reader 禁止反序列化它们 |
| observation | page_kind, page_value | 原 sourcePage 的同类类型/值；缺 page、NULL、文本、数字、boolean、array/object 分开，不猜填页号。无需 page FK |
| observation | error_name, error | 原 JS 错误类型/消息；非错误不补成 unknown。源语法错误不改成空集合或 false |

`recognized-witness-capture.ts` 仅在 ingest/offline/replay 认证使用。B 将只读结构化捕获，不导入本模块、不反序列化原值 BLOB 或原档，不重捕获、不提前决定资格。

## 显式 successor 与 #732 catalog 回执

`finalizeRecognizedWitness({source,target,runId,predecessorRunId})` 在71609上执行窄 additive successor，版本号仍71609但 catalog 改变。入口只接受固定快照与独立 target，验证源 #732 complete run/checkpoint 与真实 actual catalog，拒绝已有 A 源、同文件、活动 journal/WAL、缺前件、目标事实/catalog 漂移与低于8GiB空间。

原子事务依次认证、加列、捕获、安装 barriers、验证旧全部 cell/IDs/bytes/run/checkpoint 不变、FK/integrity、发布本 successor run/checkpoint。新 run transform 为 `recognized-witness-offline-v1`，source_schema_hash=旧#732实际catalog，target_schema_version=新实际catalog。旧#732 receipt 字节不更新。

`recognizedStoredInstalled` 只接纳这一条明确 successor 链：原#732 completed receipt/checkpoint→A completed receipt/checkpoint→当前实际 catalog，并逐一核对 A columns/defaults/FKs/完整 trigger SQL。缺任意列、篡改 trigger/receipt、未知新 catalog 仍拒绝。没有通用 reader 豁免或伪造旧 receipt。

Fingerprint FK inventory 仅在该 A 完整认证后加入 collection/observation 两条精确 archive FK。原 verifier 的私有 empty in-memory reconstruction 继承经验证的同一 catalog；正常未来 command 验证时，从认证后的原 collection archive 和旧条件原列重建本捕获，不能复制派生 witness 值自证。限定为私有空内存库，不接受普通 runtime/read-only 任意连接绕过回执。

离线重放核对固定源 hash、源/目标全cell manifest 和 checkpoint；未来 ingest 正常增加行后旧离线 checkpoint 不再代表同一目标，不能用升级重放覆盖新写。

## Writer / replay 接线

- `writeNewCollectionTarget`：原 collection archive sealed 后、写观察前捕获 recognized collection/三条件。
- `writeRecognizedTarget`：认证 collection capture；观察与本源投影建成后捕获本观察位置，同 savepoint 原子提交；existing 分支验证而不重写。
- collection replay：从原 collection 与具体 observation 认证捕获；既有 raw/hash/fingerprint 验证保持。缺 ref 不从旧表、supplement 或新版本补历史；原 SQLNULL 可证实且与缺ref区分。
- 早期阶段没有 A schema，三个 hook 保持无动作；#732 和现有 target writer 接线仍可用。全局 runtime refusal 不变。

## 验证与 B 的剩余责任

测试：`recognized-witness-input-matrix-733.test.ts` 的独立旧 typed SQL/JS 与 literal矩阵；`recognized-witness-capture-733.test.ts` 的类型原值/JS prefix/错误分区；`recognized-witness-successor-733.test.ts` 的全旧cell/receipt、物理schema、原子回滚、回执/catalog 篡改、future writer/replay 与缺ref/SQLNULL。精确名称、命令、首次FAIL、archive/restore manifest、fresh/inherited/UNRUN 在仓外 r5/capture/REPORT/HANDOFF。

A 不实现 B reader、固定asOf全字段资格/三称号/跨年完整对照、same-snapshot/current-assignment/next-request freshness 或公开名单/工作簿切换。`recognized-filter-source` 的旧环境选择器、旧公共 qualification/query/workbook/identity/H/C/X 路径仍在，待独立 A 接受后按 B/对应票删除；不把 A 测试签收为完整资格引擎接受。fullaffected145 历史未完成与全部原FAIL/UNRUN仍保留。
