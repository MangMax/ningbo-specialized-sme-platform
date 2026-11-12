# 认定目录原称号列捕获（#732 A）

A 是独立待接受候选。B reader 和公开接线未实施，不代表整票完成。

实际旧库→71609反例：两个 isolated 观察的旧 `platform_relation.title_raw` 为 `2`、`3`，raw.rdjb 同为字符串 `1`。原列表、原列精确过滤及 options 保留区别，现有 source/display 投影不能还原。原 FAIL 保留于仓外 r3a/red-2.log。

## 最窄 owner

在既有 `platform_recognized_projection` 的 observation 分支新增：

| 列 | 含义 |
| --- | --- |
| exact_title_raw BLOB affinity | 原 SQLite cell；无类型转换，保留 TEXT/BLOB/INTEGER/REAL/NULL |
| exact_title_state | captured 或 uncaptured；captured NULL 不等于未捕获 |
| exact_title_origin | legacyRowSnapshot 或 commandInput |
| exact_title_archive_id | 对应不可变归档 id 的 RESTRICT FK |
| exact_title_sha256 | 对应原字节摘要 |

version 分支这些列全部 NULL。原 `title_raw`、source title 类型/原值、资格保真字段及版本/hash/观察ID不变，不替代 query/page scope 或候选 mask。

目录其余原列：source_relation_key 由 observation 提供，原 name_raw/uscc_raw 由 revision 1 assignment 提供，当前归属由 latest revision 提供；collection 与 alias 提供查询坐标和 sequence。实际迁移测试逐列比较独立旧 SQL 与这些 owner，没有再发现已消费原列缺口。H/R5 所需其他语义不在此结论内。

## 离线操作

在维护窗口排空写入，使用既有 SQLite backup 固定独立 71609 源文件，复制为独立 target，调用 `finalizeRecognizedStored({source,target,runId,predecessorRunId})`。前驱是已完成 candidate-scope-offline-v1 回执且 schema 一致。source/target 禁止同 inode，禁止活 WAL/journal，维持 8GiB floor。

这是显式71609附加升级，不注册启动迁移、不改变全局 phase guard、普通 expand catalog 和早期 writer。新增字段只注册于专属 target schema。source 文件、全表原 cell manifest、序列、历史回执与 catalog 都绑定；target 先与固定 source 比较，事务内加列/捕获/屏障/回执/checkpoint。异常全部回滚，重放校验原 source hash、最终 catalog 与 checkpoint，不能修补漂移。

历史值只从固定 source 中已 sealed、长度和 SHA256 正确的 legacyRowSnapshot 恢复，并校验 alias/query/sequence。原快照不足则明确 uncaptured，不解析 raw 还原旧列、不用 target 残留旧表自证。未捕获不会变成 captured NULL。若需要恢复这类历史，须另提供有来源绑定的原件，由父级裁决；本候选不猜补。

新 writer 在已有 command fingerprint basis 捕获后，按旧 INSERT trigger 的 string-only/trim SQL 语法物化 stored title，绑定原 command archive。数字、false、null、空白均物化 NULL；source title 类型仍原样保存。既有71609前置命令也使用相同明确规则；旧阶段不生成新列。writer reuse 与 fingerprint/replay 重新认证 exact cell 和 source binding，未捕获或漂移拒绝，不覆盖、补猜或重建原列。

业务查询不得调用证据解析函数。B 接受后读取这些结构化列；相关读取必须先检查捕获状态，不能以新 helper 作为测试 oracle。

底层 SQL 仅用于 schema/PRAGMA、全表字节 manifest、SQLite cell 无损恢复与已接受旧 SQL trigger 语法的边界物化。新 writer 的业务插入使用 Drizzle；没有手写业务列表查询、在线锁 owner 或通用捕获框架。

## 写入与认证的完成状态

writer、指纹认证和归档 FK inventory 共用同一个 catalog 判定。无新增列、屏障或回执残留的既有阶段保持原行为；任何部分列集、错误列类型/FK、缺失或改变的屏障、错误 phase、未完成或缺 checkpoint 的升级均拒绝。完成后的正常写入不要求历史迁移数据摘要继续等于当前数据。

指纹验证的空内存库由已通过上述判定的源显式授权，并独立检查复制的 catalog；该授权仅与内存连接对象绑定，不持久化，也不允许任意文件库省略完成回执。迁移在同一事务中建立回执/checkpoint 后认证原列，失败仍整体回滚。

paired not_indexed 的 reference 路径同样认证 exact cell、原归档绑定和 captured 状态。它不执行 bootstrap、不修复原值，失败仍映射为原 relation alias 的 projection_source_drift。

完成回执的 target_schema_version 必须等于当前实际 catalog 摘要；不能仅按摘要长度放行。该绑定只覆盖结构，不比较会随合法写入变化的历史数据摘要。后续结构升级须显式更新对应接缝，不能继续沿用旧结构回执。
