# 观察 fingerprint 原输入与生命周期

状态：#723 docs-only 候选，待父线程独立审查。补充[已接受退役 ADR](2026-11-10-platform-mixed-table-retirement.md)，不表示 schema、capture、replay 或 #722 已接受。

## 缺口与选择

`canonicalPlatformJson` 对原对象的 own keys 排序并保存其存在性。三来源 target writer 对 `{collectionId,position,row,assignment}` 计算 SHA256，但数据库只保存其中的投影。合法 assignment 省略 `commandReceiptId` 与显式 `null` 可得到同一存储事实、不同原 hash。额外 assignment own key、直接 writer 的 position 省略与 null 也有相同缺口。collection request 仅保存 queryText，不能还原 assignment。current assignment 更不能证明原调用形状。

选择一张专属 `platform_observation_fingerprint_basis`，只拥有观察的索引证据，复用 `platform_archive_value` 的不可变 BLOB。表不承载业务资格、归属、通用事件或命令回执。其输入保存 hash 实际消费的 canonical UTF-8 bytes。scheme 记录索引生命周期，不加入原 hash envelope，不替换 `platform-observation-v1` 或 `platform-row-json-v1`。详细约束、验证与分票见契约补充。

## 为什么不扩现有 observation ref

| 方案 | 真实约束与代价 | 决定 |
|---|---|---|
| 给现有 ref 增加 fingerprint 字段 | 0048 CHECK 只允许 rawFields/sourceText/legacyRowSnapshot；owner 任一 ref seal 后不能再插字段。T05a、三来源 writer 已 seal。需要重建 CHECK、修改 seal 语义或重新绑定全部旧 owner，仍须另存 scheme 和 uncaptured 状态 | 不选。为单个证据缺口放宽全部原档封存边界代价更大 |
| 专属索引证据附表 | 增加 observation FK、输入 archive FK、生命周期 CHECK 和 INSERT-only 约束；扩充三个 ref 的对称碰撞检查；离线 successor phase 独立绑定 schema | 选择。原三个 ref 的字段与 seal 不变，可为既有 sealed owner 追加独立索引证据 |

三投影 `source_archive_id` 是同一 observation 的 sealed rawFields 二次指针，版本 `canonical_archive_id` 是其 sealed canonicalRawJson 二次指针，不是独立归档 owner。不能复用这些指针放输入。新 basis 的 archive 也不能与上述字段共用，即使 bytes 相同。选择不恢复正文共享 ADR 的 compiler、去重、片段池或 GC。

## 原承诺的影响

| 原承诺 | #723 的限定补充 |
|---|---|
| 旧 hash、原文、ID、projection rule 不变 | 只追加原输入证据和 scheme；无法恢复时保存 uncaptured，拒绝认证，不重算覆盖历史 |
| archive 首次 seal 后不能扩字段 | 原 ref 规则完全保留；新 owner 是专属索引证据，不是绕过 seal 给旧 ref 添字段 |
| 历史 envelope 与 expected digest | 观察已有 input_fingerprint 是待核输出；不新增由它派生的 expectedHash 作为独立来源。其他 H2 算法仍各自验收 |
| assignment 追加修订 | command hash 对 revision1 的原投影验证；当前归属正常追加不使旧输入漂移。legacy hash 不含 assignment |
| 离线 phase 与旧 binary refusal | successor 独立版本、run/checkpoint，不改写 71605/71606 回执；保留非零 phase 的 runtime 拒绝 |
| 新观察 snapshot、公开 DTO 与证据序列化 | 仍归原 C3/H2 承诺；basis 不冒充 legacyRowSnapshot，不改变公开 API |
| W4 replay 原行为 | migrated F1、rule 校验和完整 mapping F2 仍是 #722 原义务。新输入认证才依赖后续切片 |
| R/H/C/X/Z、业务资格、整体迁移与生产批准 | 无新增实现或接受声明，无全架构重写 |

## 静态依据

固定基线 `c2e5dda4003df558968efef681a72e765f36c597`，#722 只读候选 `3d4ea502b4ff4ac0afd72ed8d866ff954b79e78e`，未合其代码。

- [0048 archive 约束](../../db/migrations/0048_cute_madelyne_pryor.sql)：三 ref CHECK、seal-only UPDATE、跨 ref INSERT collision。
- [0050 投影约束](../../db/migrations/0050_source_projection_observation.sql)：source_archive_id 与 canonical_archive_id 必须绑定其 sealed 原档。
- [archive 服务](../../lib/platform/immutable-archive.ts)、[target 注册](../../lib/platform/target-schema.ts)、[phase guard](../../db/schema-phase.ts)、[离线 finalization](../../upgrade/finalize-observations.ts)。
- [原 public oracle](../../server/utils/platform-business-record.ts)、[canonical serializer](../../lib/platform/observation-plan.ts)、[三来源写入之一](../../lib/platform/apply-target-writer.ts)、[command](../../lib/platform/collection-target-command.ts)、[历史转存](../../upgrade/observations.ts)。另两源按各自 parser 核对，不合并业务字段规则。

仓外研究根为 `/Users/mang/.t3/acceptance/platform-complete-migration/w4b-replay/`。`INDEPENDENT-REVIEW.md` 的 F1/F2 FAIL 不变；`fingerprint-gap/NEXT-TICKET.md` 仅研究候选，本选择以实际 seal/phase/归档引用约束复核。原始反例与本轮只读范围记在 `fingerprint-contract/REPORT.md`。本轮 runtime、DB、tests、build、真实数据及修复后验证均 UNRUN。
