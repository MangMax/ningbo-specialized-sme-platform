# 拟议：来源字节兼容先于 SQL 快照接入


> 2026-10-23 最新用户澄清已取代下文的实施方向：保留现有来源快照、指纹与审计算法，允许单个所选来源完整水合，按实际内存/耗时调整任务限额；避免全量归档水合。旧的“不许调整1 MiB、F1必须先建设JSON/SQL/native快照接缝”不再是当前约束。下文保留为历史实验/提案，兼容失败与旧资源观测不撤销，也不授权继续这些切片。后续实现与验证范围由关联 Issue 追踪。

**状态：proposed，未批准、未实现。** 关联 [#220 spike](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/220)、[#210](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/210)。

用户已明确：没有既定内存预算或恒定总 RSS SLO；目标为 JS/IPC 不完整水合单份原档，记录 main/worker/SQLite 的绝对内存观测，不新增固定来源大小排除。SQLite 完整构造的 O(N) 原生内存可以被评估，必须诚实披露，不能用 V8 heap 或64KiB输出冒充总内存界限。

建议把 SQL 来源构造、分块 SHA 和完整审计复制保留为**有条件的局部接缝**，归权威 correspondence 领域所有；不改变 SHA 输入、plan/request绑定、完整历史证据、proof授权或 revision 语义。先独立落地可验证的审计复制/标量回执；来源接入必须先证明 JSON.parse→JSON.stringify 精确兼容。本轮40例中24例不兼容，故不接入 JSON1 原样转发、不移除 #214 门槛后宣称修复；F1仍阻塞。

当前不选择存储迁移、指纹新版本或通用流框架。若两个 JSON 列无法在现有 SQL/native 接缝保持成员顺序、重复键、Number 和 Unicode 字节语义，先独立 spike/重新定级。全水合 worker、截断 provenance、仅支持规范化来源或更高来源大小拒绝线均不能替代用户要求。完整历史 audit 复制旧 snapshot；#213 已有 candidate 改选先校验并保存有效 comparisonProofIds，再复制新的确认 evidence，不能从旧 candidate 偷换授权。

后续实施仅按 spike 列出的 ≤M 条件切片推进；本 ADR 提案不授权生产代码、部署、数据写入、关闭 #214或母规格验收。
