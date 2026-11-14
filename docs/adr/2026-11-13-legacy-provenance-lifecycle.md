# 历史分页补录与已封存 collection

状态：#754 docs-only 候选，待父级独立 Standards/Spec 审查与 LOCAL 接受。基线 `d359b85efd4ff4d6d789733ec959383be0bf6532`，tree `229d1907db6a993fd8714a45a619ae2e412ef4d9`。scope:M，高难度；本票只交付一个契约补充，不接受后续 schema、命令或读取实现。

## 封存之后仍需保留原补录命令

`payload.platformLegacyProvenance` 对一个 `business_list` 原查询补入分页来源，原查询的 `collectionEvidence` 必须为 NULL。预检按旧 ORM 对象计算 `SHA256(JSON.stringify({query, rows}))`，提交重核原输入。成功只新增独立 metadata，返回 `typedState=unknown`。它不重新采集、不索引业务，也不重写原查询。见[原命令](../../server/utils/platform-legacy-provenance.ts)第19–69行和[完整公开行为测试](../../tests/platform-legacy-provenance.test.ts)。

T04 把既有 metadata 的原列保存为 `T04-PROVENANCE` 封套。collection 在同一事务首次 seal，之后任何字段都不能追加或改绑。`provenancePresence` 还要求 T04 或 W4a 的完整固定字段集合。因此已迁移、无 metadata 的正常历史查询无法继续原补录命令。#753 只处理观察索引，不授权改变此生命周期。

## 方案比较与选择

| 方案 | 对真实所有者的影响 | 结论 |
| --- | --- | --- |
| 扩充或重开 collection ref | 0048 的 `no_replace` 在任一字段已 seal 时拒绝插入；还要修改 T04/W4a 固定字段认证。新补录会改变原归档集合，影响所有 archive reader | 不采用。保留原 ref、seal 与字段集合 |
| 一张 collection 专属补录 metadata 附表 | collection FK、一 collection 一条、全历史唯一文件 SHA/segment；新补录 JSON 使用独立不可变 BLOB。旧 T04 封套只增加结构化查询索引，不搬动原字节。命令和读取各增加一个限定接缝 | 推荐。允许已封存 collection 获得一次独立补录，复用既有 archive、caller batch 和 receipt |
| 新建 collection 或观察承载补录 | 产生第二个采集时间、自然键或 observation 身份，必须转接 aliases、决定、113、历史回执；相同 version 的不同观察也会被误合并 | 不采用。补录不是一次新采集，也不是新观察 |

选定第二项。新增表只拥有这一命令的 metadata 与归档绑定，不是事件账本、命令账本或第二套业务模型。原字节仍在 `platform_archive_value`。不引入完整性树、正文共享、去重或 GC。详细字段、来源输入、事务、消费者及 ≤M 分票见补录契约。

## 对已接受契约的限定补充

| 已有约定 | 本补充 |
| --- | --- |
| [退役 ADR](2026-11-10-platform-mixed-table-retirement.md)“责任与数据流”及主契约“标识与存储”将 provenance 交给 collection owner | 增加 collection 专属附表，覆盖首次 seal 之后的同一命令。原 collection 的采集列和 refs 不更新；旧 T04 metadata 与新补录共用唯一性和读取解析器 |
| 主契约“不可变归档与引用”要求保留原算法输入 | 逐字段定义此命令的旧 query/rows 投影。它与 observation fingerprint 不同，不能复用其 digest。完整正常路径的已有原档足够作为重建材料，后续必须独立验证，不能用当前 target 对象直接 stringify |
| [观察 fingerprint ADR](2026-11-11-observation-fingerprint-basis.md)允许专属 basis owner | 仅借鉴专属证据的边界。不扩 observation basis、不改变其 scheme 或 hash，不为补录另存一份可从现有原档无损重建的输入 |
| 主契约“范围与条件”“写入、快照与失败” | 补录页只改变选中证据的展示位置；原采集 coverage、业务 predicate、qualification、决定和原 receipt 不改变。预检可写原有 import 预检回执，业务源保持只读 |
| #751、#752、#753的显式目标边界 | 后续 successor 仅在显式注入、完成迁移的目标上接入本命令及读取。普通 runtime/import/worker guards 继续 CLOSED；schema0 原分支保留 |
| 主契约“迁移检查点与切换”和 #744 简化兼容 | 必要 successor 只建立专属 metadata 及旧封套索引，沿用现有 run/checkpoint completion。运行时检查受支持版本、必要列、完成状态，不恢复 DDL/hash 信任链 |

历史旧文档中的“待接受”文字不在本票回填。父级提供的既有 LOCAL 接受事实与本票新证据分列；本候选不宣布 #706/#690 完成。
