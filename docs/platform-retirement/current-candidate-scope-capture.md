# #731 A：候选范围专用捕获（71609）

原候选 `current-platform-scope.ts` 按严格 SQLite JSON validity、原 fetchedCount 类型/成功页 ordinal 前缀与既有 title_code/rdjb fallback 求范围。实际 T04→71608 中，JSON5/严格 JSON 与 text count/NULL 各能得到同样结构化页，却有不同候选集合；condition/value_kind 是请求条件，不能补足页原类型。A 在原观察 owner 追加结果捕获；B reader 尚未实施，不代表当前名单或退役整体可运行。

## 值与来源

显式 `71609` 在原 `platform_business_observation` 追加八列，不注册到普通 expand schema、不增加候选表或通用 effectiveTitle：

| 列 | 语义 |
| --- | --- |
| candidate_scope_state | captured / uncaptured / error；默认 uncaptured |
| candidate_scope_mask | captured 时 INTEGER 0..7；bit0 innovative_sme、bit1 specialized_sme、bit2 little_giant。每 bit 只表示原 relationScopeSql 对该 title 为真，NULL/false 不置位 |
| candidate_scope_rule | captured/error 固定 current-candidate-scope-v1；uncaptured 为 NULL |
| candidate_scope_archive_id | captured/error 绑定本 collection 已 seal 的原 collectionEvidence archive，FK RESTRICT；uncaptured 为 NULL |
| candidate_scope_rdjb / candidate_scope_title_code / candidate_scope_sequence_no | 原 collection rdjb/title_code 与本 observation sequence_no；保留 NULL/原字符，触发器校验 owner/上下文 |
| candidate_scope_error | captured 为 NULL；error 保存旧 SQLite malformed JSON/integer overflow；uncaptured 保存原因，如 missing_original_collection_evidence |

mask=0 是捕获后的三个谓词都不为真，绝不能代表 uncaptured。未知但旧规则允许的 token fallback 仍产生相应 bits。原始 SQL NULL 有真实 archive row/ref 时按 NULL 输入捕获；ref 真正不存在时留下 uncaptured，不新增或冒称 null 档。supplement 不代替原 collectionEvidence。原 requested membership、页、行 title、source projection、归属、资格规则相互独立，无 key、未索引、无投影、待核观察也捕获范围。

只有 ingest/offline/replay 认证边界运行候选专用 SQL。原 archive 的 storage class/bytes 按 SQLite 传入（TEXT 用原 BLOB bytes CAST TEXT），不经 JS parse/stringify；因此严格 validity、重复键首值、SQLite count/SUM coercion 不丢失。其他数据库/编程错误抛出并回滚，不吞成 error 状态。业务 reader 不调用该计算或解析 JSON；B 后续只消费结构化结果，并显式处理 uncaptured/error。

## 离线 successor

在操作者维护窗口内停写、排空任务，用既有 `upgrade/run-snapshot.mjs`/createOfflineSnapshot 获取 SQLite backup（包含已提交 WAL）的一致 standalone 71608 文件；snapshot owner 继续确保无并发写。将其复制为独立 target，不能原地改源。

```
node upgrade/run-candidate-scope.mjs SOURCE_71608 TARGET EVIDENCE RUN_ID APPLY_STORED_PREDECESSOR_RUN_ID
```

source 必须有 complete 的 apply-exact-stored-offline-v1 回执、同 catalog phase71608。显式 successor 绑定源文件 SHA256、schema hash、逐 cell manifest、原上下文；target 初始数据/catalog 必须与该固定源一致。FK ON 的单次 immediate transaction 中 ADD COLUMN、逐观察捕获、安装不可变约束、核对所有原字段/旧回执/sequence、写 phase71609 与新 run/checkpoint；任一步失败全部回滚。旧阶段历史回执不改。新回执绑定目标 catalog 与全量捕获 manifest，exact replay 重验源/目标/上下文/结果且不写；捕获后的新写会改变 manifest，不能沿旧回执伪装 exact replay。CLI evidence 目录独占创建，失败记录保留。8GiB floor，禁止用业务活库代替隔离 target。

## 新写与 replay

现有 collection-target-command 同事务先保存/封存原 evidenceText，再调用三源 writer。三源只在 observation INSERT 时调用同一个候选捕获边界；不增加 raw/status/year/title 共享业务解析，不把新捕获值加入原 canonical fingerprint 输入。单独调用来源 writer 时若 collection 尚无原档，插入明确 uncaptured；这不是可公开查询的完整采集，新 collection owner 必须先 seal 原档。对已捕获 owner 禁止 UPDATE/DELETE/REPLACE，collection 的 rdjb/title_code/id 与 observation 的 collection/sequence/id 不得改变；last_collected_at 与 append-only assignment revisions 不受影响。

writeCollectionTarget 的普通/引用 replay 认证原 source payload 后，比较本观察捕获结果/上下文/归档绑定，不修写旧 mask、不更新原 hash/回执。71609 的 source writer/fingerprint 认证链继承71608 apply stored 规则，并校验新增 archive FK owner；旧71605–71608 行为和限制保持。71608 专用申报业务 reader、旧 offline successor 仍明确拒绝71609，无自动 fallback。普通 db/worker 的非零 user_version guard 不解除；没有公开路由或运行 selector 切换。

## 接受与恢复边界

A 的独立接受仅覆盖 sourcecapture/schema/writer/replay。B typed union/count/page/一次枚举接缝以及 R5/H/C/X 仍待后续。没有新增索引或性能结论。原 ID、业务/source 列、原 archive bytes/hash、fingerprint、alias、归属、已完成工作簿与旧回执保持。

失败事务自动恢复71608。成功后默认使用支持71609的二进制继续维护，不能放开旧公开 runtime。尚未开放新提交时可恢复经校验的原独立71608副本；已经有71609新提交时不得覆盖新回执，须保留当前 DB/原档并前向修复或单独审查逆向恢复。A 不提供抹去新写的降级或生产部署授权。
