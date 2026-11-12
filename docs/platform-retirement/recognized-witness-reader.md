# #733 B：显式目标认定资格见证 reader

状态：B 实现候选，待父级独立接受。基线为已独立接受 A 的 LOCALintegration `23d0c10459ecb3cb78cda9524b67b1cc83f9289a`，tree `2dde5c16ab5dee5e8a5f206131286199ac392ed9`。本片≤M，只提供 R5 reader 与必要 qualification/list 依赖接缝；不切公开入口或重写资格/H/C/X/current identity。

## 读契约

`createTargetRecognizedWitnessReader(db)` 要求已完成 A 的实际71609 catalog/receipt。没有 source/env 参数；缺 A 或 catalog 漂移即拒绝，不回退到旧 query/relation 或 source archive。

`readMany({enterpriseId,uscc,relationIds})` 按 legacy relation namespace 解析 alias→observation→collection，并返回以请求 alias 为键的 Map。queryId 返回 legacy query alias，不假定它等于 collection PK；未来 alias/PK 分离也如此。ID 必须是正 safe integer；USCC 比较保持原 `normalized(raw) = suppliedNormalizedKey`，不从 record/directory 推断归属。读取同一 snapshot 的最大 assignment revision 和该观察的已验证 version source-fidelity 行，confirmed/resolved/verified、record interface、已捕获 fidelity 的门槛保持。

结果为以下区分联合：

- available：旧 typed source 的 queryId/titleCode/rdjb/sequenceNo、三条件提取值和原 source-fidelity 输入，加 A 的结构化 matched/unmatched 位置。matched 保留原 ordinal、JS property key、sourcePage kind。
- unavailable：missing、owner、unconfirmed、unverified、fidelity_uncaptured、evidence_uncaptured、not_applicable、position_rejected 分开；这不是企业资格的 false，也不删除候选。
- 原 SQLite/JS 语法错误按已捕获的消息及错误类型抛出；binding/缺 alias/未知捕获状态为显式 target gap。批量 SELECT 不改变请求顺序所决定的首个错误。

只选 collection gate/state/rule、condition witness_kind/witness_value、观察 witness binding/key/ordinal/page kind、当前 assignment 与 version fidelity；归档只 JOIN 已 sealed ref 的 ID/hash 元数据，不选 bytes。没有 JSON/JSON5/源码/v8 业务解析、重新 capture、normalized display 或 candidate mask 判资格。

A 的 `witness_rdjb_key` 是 UTF16LE 小写 hex TEXT：1/2/3 分别3100/3200/3300。固定 code-unit decoder 保留 NULL 与空 key、孤立 surrogate、astral pair/NUL。随后仍由原 RDJB 字典执行原查找，包括 JS property-key/prototype 行为；不把 key 提前压成 title 枚举。

原 R5 消费块只使用 `sourcePositionForSequence(...).sourceRdjb`，没有读取 sourcePage 的值。故 B 不反序列化 rdjb/sourcePage raw-value BLOB，也不重建 pages JSON/不存在的 page FK。原 sourcePage 值与类型/ordinal 继续由 A 保存；本接口只需要 page kind 与 ordinal，没有据规范化 page_no 猜补值。

## 请求、批量与快照

请求去重保持首次顺序，每256个 alias 一条 ORM 数据 SELECT；只取所请求观察，不扫描全档案。结果只属于本调用，没有跨 request/revision/day 的业务缓存。

`withinSnapshot(read)` 是同步请求作用域。在 streaming candidate SELECT 开始前、同一 caller transaction 中认证 A catalog，作用域内复用这项认证；不缓存 rows/facts。退出或异常即清除作用域。直接调用 readMany 时，它自己开 read transaction；已有 caller snapshot 时沿用它。调用者不可让 callback 越过同步作用域或自行结束后继续读取；没有 busy retry、commit/rollback 恢复或连接切换。

资格依赖请求按原“当前 grant→该 grant 的有效 recognized links”顺序展开，再批量去重。未来/非当前 grant 的 link 不提前读取。每个 title evaluation 的多个 witness 共用本次批量数据，原逐 grant 的范围冲突、未知 facts、冲突归并与同 witness AND 规则不改。

## 显式接缝与仍旧读的边界

- `createCurrentQualificationAssessmentReaderWithWitnesses(native,witnesses,receiptRuntime?)`：强制同一 native connection，使用结构化位置与原 recognizedFilterFacts；拒绝 recognizedFactSource 选项。完整资格规则/#687、receipt/hash 算法不改。
- `listCurrentQualifiedWithCandidatesAndWitnesses(native,filter,candidates,witnesses)`：两项依赖都显式且同连接。候选只枚举一次；BEGIN 后、枚举前认证 witness catalog，count/filter/page hydration 共用 pinned snapshot。source/env selector 不进入此接缝。

这些只是 R4/R5 组合接缝，不是完整71609名单公开入口：current-identity-keys 的旧 query/unassigned keys，correspondence validity/provenance，query coverage、difference/source status/year/batch、full assessment hydration仍旧读。默认 `listCurrentQualified`、`listCurrentQualifiedWithCandidates`、`createCurrentQualificationAssessmentReader`、workbook/worker 继续原入口。新接缝的整体 trace 仍会包含这些未迁路径；只有 R5 reader lane 的 trace 证明目标纯结构化。全局 `assertExpandRuntime` 不变。剩余路径和责任在仓外 r5/reader/REPORT/HANDOFF 精确列出。

## 验证范围

真实合成旧源→全部既有迁移→已接受 A→B，以独立旧 typed SQL + 原 JS position/literal 作同输入对照；另外在固定三日期、三称号、12组 filters 下比较完整列表/assessment 每字段、count/options/order/page，验证#687不退化及一次候选枚举。alias/PK 分离用真实未来 writer 与独立旧 typed payload 对照；当前归属修订用双连接 synthetic WAL 同 snapshot/next request 控制。

SQL trace/EXPLAIN、批量 query 数、typecheck/catalog/diff、全部 first FAIL、fresh/inherited/UNRUN 和逐文件恢复清单在仓外 `platform-complete-migration/r5/reader/`。无真实数据、整体现实性能、full suite/build/UI/Docker/部署/生产签收。历史 fullaffected145 未跑完仍保留；不由本次其他计数替代。
