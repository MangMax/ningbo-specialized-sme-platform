# reconcile 旧四槽的专用完整性捕获

状态：#763 A docs-only 候选，pending 父级独立 Standards/Spec review 与 LOCAL 接受。补充[完整退役 ADR](2026-11-10-platform-mixed-table-retirement.md)与主契约，不授权 B 实现、全局运行或生产切换。

旧 `queryPlatformSlots` 把 `legacy-slot-pages/v1` 放入 rawResponse；`freshStoredSlotsSnapshot` 先按 queriedAt/public query ID 选择每槽最新，再用 `readCompleteLegacySlot` 认证封套、页原文及有序字符串行。T04 目前从 collectionEvidence 或补录捕获通用页，rawResponse 只归档。保留原 bytes 已由旧契约要求，但这些通用字段不足以表示原 validator 的全部结论。本轮只确认源码缺口，没有运行迁移反例。

选择在原 collection 增加专用 state/rule/raw archive binding/row count/input digest/reason。捕获边界执行原 validator，原页留在已 seal 原档；运行准入只消费结构化结果。本源 observation 投影继续拥有 stored/source/reconciled/conflict，typed 原输入只在选定后恢复。详细字段、顺序、来源 owner 和验收见捕获契约。

不采用 runtime raw JSON 完整性 fallback，它延续待退役的业务解析。不把 raw 封套页覆盖到通用 page/completeness，它会改变 evidence/supplement 优先级和既有 scope/position。也不复制另一套逐页逐行表。专用验证结果保存旧谓词所需结论，原输入绑定使离线和 replay 能独立复核，又不扩业务模型或原 archive ref 集。

推荐从同一固定 schema0 snapshot 建立新 target，在第一次 T04 schema/transform 绑定前安装专用 prerequisite，以明确新 transform 捕获并核对全部关系输入，实际链继续到当前71613。已完成及中断的旧 T04/后继 schema、transform、checkpoint、receipt 保持原值；不预设71614。已有后续新写的旧 target 不被旧备份覆盖，原地增量升级须另有父级裁定。这个选择限制旧 target 的自动准入，换取不改历史绑定和不丢新提交。

四槽最新失败遮挡、JS 字符串 freshness、typed 原值与顺序、逐观察冲突、原 cells/hash/alias/history 和 global guards CLOSED 均保持。DISPLAY-only 与历史 DTO 不进入决定。本轮 runtime、DB、fixture、tests/typecheck 均 UNRUN。A 接受后，离线 capture、新写 replay、reconcile 显式接线按三片 ≤M 候选分别授权、分别接受。
