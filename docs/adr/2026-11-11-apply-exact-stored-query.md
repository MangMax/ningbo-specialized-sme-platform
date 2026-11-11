# 申报旧存储列的结构化查询保真

状态：#727 docs-only 候选，待独立接受。固定基线 `a54afbe2c48c3ea085102dfdceada4bab27c94c9`。本选择补充[完整退役 ADR](2026-11-10-platform-mixed-table-retirement.md)，不改变其已接受范围，不代表运行迁移通过。

## 缺口

旧 isolated 申报列表、count 和 options 直接读 relation 原列。原[退役契约](../platform-retirement/contract.md)把原列放 archive，只在结构化 projection 保留 trim/字典转换后的 stored 比较值，无法覆盖这些旧查询。R1a 已保留反例：同 raw、无业务 key，旧 status 分别 `" pending "` / `"pending"`，旧 filter total1/options2，71607 target total2/options1。archive 字节没有丢失，但业务查询禁止从 archive JSON 筛选。

## 决定

在现有 apply observation-owner projection 追加 exact_status、exact_declare_kind、exact_applied_at、exact_year、exact_title_raw 和捕获状态/规则/来源。保留旧 SQLite affinity、storage class、NULL、空白和实际类型。复用 source_relation_key 和已验证的 assignment revision1 原名/统代，避免重复存储；当前 owner 仍取最大 revision。

不新建表：现有 observation-owner 已提供唯一行、来源 FK、封存原档和逐观察比较字段；新增事实仍属于该观察的申报字段。不得把它放通用 observation 或共享 version。observation 上只允许为 commit-time 配对约束增加内部引用，不承载业务值。

[具体契约](../platform-retirement/apply-stored-query.md)冻结字段/消费者矩阵、literal/SQL 旧 oracle、五列类型与捕获状态、71608 successor、T05/71607 恢复、真实旧插入 materialization、新 writer 与 replay 原输入认证、完整回滚及无环 S/W/R1a 顺序。schema/offline 与 writer/replay 各≤M，后续独立授权和接受。

normalized/stored-comparison、parsed、reconciled、conflict 字段及来源 parser 均保留。records/detail 版本字段仍来自版本 projection，facts 仍遵循逐观察 conflict 和 withArchiveProcessFacts；exact 分支只补原列需求，不全局替换 fact 值。旧 hash/bytes/ID/alias/time 不变，不以修改业务规则迎合归一化。

## 门槛

历史优先从可信冻结 source cell 或同 owner sealed snapshot 恢复；新 command 从真实原输入按旧 writePlatformQuery 规则物化，不能把 normalized DTO 当原输入。不可恢复保留 uncaptured 并阻塞请求域完整读取；原档/映射证据冲突拒绝。恢复原档仅限离线，运行 archive 仅按 owner 验证输入，不参与 membership/count/options。

新增 phase 的旧 writer 屏障、实际 FK-ON、延迟配对 outer COMMIT 和 populated DDL 回滚由 S 独立证明；W 保留原 hash envelope 并认证 exact 分支，R1a 才验收查询输出与性能结构。旧 runtime/worker refusal、公开接线、#722 F1/F2、生产最终审批继续各自门槛。

process/recognized 同类原列风险只登记有源码的消费者，分别留 R2/R3，不夹带实现。原 R1a FAIL 不变；本轮仅文档检查，runtime/tests/build/DB 均 UNRUN。
