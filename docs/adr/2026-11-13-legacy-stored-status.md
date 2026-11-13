# 旧关联办理 status 的 source-owned BLOB 表示

状态：#760 stage A docs-only 候选，待父级固定候选独立 Standards/Spec 审查。补充[已接受完整退役 ADR](2026-11-10-platform-mixed-table-retirement.md)和[数据契约](../platform-retirement/contract.md)，不表示实现、迁移或 stage B 已接受。

基线 `d0cc15684e337903e788063bf74fa480a117d7ae` / tree `af5a94bdcabc21e2fade1589af4fa69f4e2e7753`。原 schema0 relation1101 的 status BLOB `00FF` 已被旧公开service/indexing/selected detail接受，archiveProcessFacts.status为Buffer；真实T05b却拒绝TEXT-only比较槽。原作者零产品修改，10项诊断PASS与实际迁移FAIL均作为继承证据保留。

## 决定

在现有 `platform_business_projection` 的 observation-owner `stored_status` / `reconciled_status` 槽保存 native BLOB；仅此来源/字段的 stored kind 增加 `blob`。用检查过的 `string | Buffer | null` 和field/interface分支描述真实输出。parser及version内容status继续TEXT/NULL；process exact_status继续原SQLite cell。BLOB不trim、不转NULL/字符串，空BLOB仍是非空cell；与非空parsed TEXT严格不等，冲突值原样保留。既有版本补充规则与公共JSON的Buffer序列化保持。

比较过同表独立 `stored_status_blob` / `reconciled_status_blob` 列。它需要额外互斥状态、跨列reconcile和所有reader/verifier的双路重组，且不解决原run绑定，因此选择现有native槽。业务仍由来源投影拥有；无通用observation业务列、第二fact表、JSON/snapshot业务fallback或新hash算法。

此选择明确修正原主契约“文本比较列均TEXT”的status特例；不削弱原归一化/冲突、原cell/bytes/hash/PK/receipt/113/114保全义务，也不将其他字段或来源的非TEXT准入一并扩大。

## 离线边界

在全新独立target完成expand后、首次T04 schema绑定前，以专用offline prerequisite修正business status CHECK。保留0050及migration历史，FK-ON事务保全version行、索引、trigger、sequence与全部原cell；新T05b使用显式v2 transform。随后走实际原source→71613全链，并同步修正legacyFingerprintInput的status decoder、process recovery admission及selected facts类型。不能只放宽首个CHECK而把同一status在后续标成uncaptured。

既有completed71613和中断run保持原schema/transform/checkpoint绑定。新鲜v2链可同run按原绑定重试；旧失败隔离副本需保留证据，再由同一固定源创建新target/新run。未证明存在需要修复的已完成BLOB目标；71613之后successor不能解除已失败的T05b前置CHECK，因此本候选不新增successor，也不承诺online repair或覆盖后续新写。

[具体补充契约](../platform-retirement/legacy-stored-status.md)冻结精确字段/CHECK、类型草图、原严格不等与版本补充、source→full71613路径、各owner、既有绑定处置和真实完整管线/旧service/literal/selected read/回滚重试/完成重放验收。#760保留A→独立接受→B≤M的同票清单；B需要父级另行授权。

本轮仅静态源码/文档核对；运行、fixture、tests/typecheck/build/wire均UNRUN。其他非TEXT字段的整体合法范围未知，不能声称全域兼容；实现若遇到超出本source/status边界的必要业务改动，应带精确反例报告NOTREADY。
