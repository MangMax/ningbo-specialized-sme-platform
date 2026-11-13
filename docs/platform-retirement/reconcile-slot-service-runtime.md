# 显式目标 reconcile 四槽读取（#768 / B3）

正常 `runPlatformReconcile` 在 71613 上使用实际服务的原 SQLite connection 创建目标 reader；测试也可显式注入 `targetSlots`。reader 拒绝不同 connection，每次调用在同步读事务中检查现有 provenance/capture readiness。未完成的目标不回落到旧表。schema0 分支仅承接迁移对照，最终运行准入和旧分支退役由整体切换完成。

原 `getComparison` 继续从 record/enterprise 收集、过滤、排序和分页目标。adapter 仅按原 queryKey、四种 interface/rdjb、collection/public query alias/capture 元数据选槽。使用原 JS `queriedAt.localeCompare` 和 public alias 倒序，每槽先取最新，再检查 status、字符串 freshness 和 capture。miss 是缺槽；error 暴露原 JSON decode 错误；uncaptured 为 NOTREADY。不会回退较旧 complete，也不按称号、企业归属、current assignment 或版本过滤观察。

同一事务内，分类读取全部有序 observation、revision1 原名称/统代和本源 observation projection 的 stored/parsed/reconciled/conflict。无版本、无业务 key 和未确认行仍保留。同版本的不同观察不合并；business native BLOB/empty BLOB 继续由既有 status 类型拥有。共享业务记录没有 mutable current-version 指针；后续内容版本不能改写原观察事实。

完成选择和分类后，`selectedReconcileObservationInput` 与 `selectedReconcileCollectionInput` 才读取选定 owner 的 sealed 原档。前者复用既有 native cells/typed JSON 解码，恢复原 fallback truthiness、own keys 和顺序；后者只恢复已准入原封套的报告材料，不运行 validator 或重新判定完整性。字节 hash、长度、seal 或绑定损坏显式失败。未选原档、display/history DTO、canonical version 和全库 manifest 不参与准入或分类。

服务仍经 `buildPlatformWritePayload` 和默认 `inProcessReconcileWriter` 执行真实统一 preflight、commit 与 receipt。选定原件在同一读事务内冻结，复用 #771 的整条 query 编码：兼容普通请求保持对象、字段顺序与字节，fallback 输入则发送完整原 sequence reference。writer 继续认证原件。决定 freshness、确认、自然键引用、幂等和网络凭据/重试/pageSize 政策保持原值。

专属验收为 `tests/reconcile-slot-service-768.test.ts`。测试仅使用已接受 B1 authority 的 COPY0600，并从一次 owned physical-absence baseline 复制各独立 case；这不是生产 DROP 授权。源码绑定、完整命令、首 FAIL、恢复、类型差分与局限以仓外 `reconcile768-r2/REPORT.md` 为准。本接缝不签完整 #763/#706、资格 #738–742、worker/global cutover、HTTP/MCP/Nitro、CI 或生产。

本轮固定 base `c261f2cf4c95d36898277d52d1394dc08bbd7ee7` 已接受 #769：`StoredSlot.titleCode` 必填，schema0 复用保存原称号 metadata，新采集保持原 rdjb 映射。target reader 直接提供已选 collection 的原 `titleCode`，包括 NULL 与非 NULL 错配，不推导、不 fallback、不修写。原 B1 四槽经真实目标收集、默认 writer、receipt 和 replay，以独立完整 literal request/report/decisions 验证。旧 `reconcile768/` 的 titleCode 首 FAIL 与 NOTREADY 证据不变。

typed 原输入恢复不扩大 fresh 输入契约。2026-11-13 组合验证在物理无旧 query/relation 的目标副本通过 6 条正常路径：原 B1 完整请求/报告/回执、普通 typed 四槽、完整 no_record、NULL 和空对象 fallback reference，以及缺槽新采集。NULL/空对象用例同时调用正常 schema0 与自动目标服务并真实提交，保全原观察/归档/别名。历史拒绝证据保留于原 `reconcile768-r2/`，本次恢复证据位于 `target-final-integration/runtime01.json`。边角历史输入、全套/构建和整体验收不由这 6 条用例签署。
