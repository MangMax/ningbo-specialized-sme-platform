# #731 B：显式71609候选 reader

A sourcecapture 已独立接受。B 的 `createTargetCurrentCandidateReader(db)` 只面向该 phase，返回 `iterate(title,sort?)`、`count(title)`、`page(title,offset,limit,sort?)`。无公开路由、环境 selector、旧表 fallback 或跨请求结果 cache；expand runtime guard 保持。page limit 为正 safe integer，offset 为非负 safe integer。

## 范围与归属

业务过滤只读 A 的 candidate_scope_mask/state。不能重算 requested/page/row title，不能调用 captureCandidateScope/candidateObservationValues，也不读取 collection/page/三投影/canonical/archive JSON。原collection/page/row关系与所有异常计数、JSON5/重复键语法已在A捕获，B信任已接受71609的不可变结果。

union 保留 record、difference_reason、record_correspondence（非空企业，包括原未确认/拒绝状态）与所有 scope 命中的 observation。后者读取同一 SQLite snapshot 内最大 assignment revision；显式 enterprise_id 优先，仅NULL时按旧 roster84_uscc(uscc_norm)=roster84_uscc(uscc_raw) 解析企业。保留旧空规范码、多原值归一到同一USCC等边界，不借用 projection/version 的USCC或 owner。无 key、未索引、无投影、pending、同版本多次观察均不作为排除条件；UNION负责企业PK去重。

uncaptured/error 不能当 mask0，读取前显式抛 TargetCurrentCandidateGap，带观察ID/state/reason。错误观察即使无可解析 owner，完整旧SQL仍可能在join短路前抛错，独立原SQL测试已证实；B不擅自把这种错误变为空集合。已捕获且本title bit未命中的观察不会因缺失assignment而阻塞该title；本title命中而缺assignment则明确报gap。缺assignment不等于已知无归属（有revision、enterprise_id为NULL）。

## ORM、迭代与 snapshot

union、最大revision、USCC条件、count、NOCASE排序与PK tie-break、limit/offset 全由Drizzle构造。ID升序；name升/降序都以PK升序稳定打平。count/page 使用同步事务，迭代复用调用者已有事务，否则拥有一段read transaction；正常耗尽提交、提前break/throw先finalize cursor再回滚自己拥有的transaction。不会提交/回滚调用者的outer transaction。

唯一窄例外：安装的 drizzle-orm0.45.4 better-sqlite3 PreparedQuery/session/select 没有可用同步streaming SELECT执行器（本机实际失败及sourcecapture证据保留）。iterator将完整ORM query的`toSQL()`交给同一connection的native prepare/iterate，只映射单列id；不手写或改写业务SELECT。使用`.all()`会失去#702的窄投影内存边界，分页重复枚举则改变#702单次枚举要求，因此两者均不采用。count/page仍用ORM执行API。BEGIN/COMMIT/ROLLBACK仅协调iterator生命周期，不构成业务SQL例外。

## 消费者接缝与后续

`CurrentCandidateReader` 定义iterate及只读connection identity；消费者拒绝跨connection注入。`listCurrentQualifiedWithCandidates` 与 `writeCurrentWorkbookWithCandidates` 提供显式依赖注入，使用同一connection/snapshot；原公开函数包装既有legacy provider，保持既有行为，未新增运行选择器。#702原Float64Array4096分块、五sheet上限、一次枚举后hydrate结构不变；#691assessmentReader/identity读取、asOf/规则版本、#687资格算法不改。

这些withCandidates函数仍有R5/identity/资格/引用旧路径，不是可运行的完整71609名单或导出入口。B测试分别验证真实target候选与phase0既有assessment/workbook的注入契约，不把跨库拼接当完整snapshot证明。R5/current-identity/H/C/X消费者明细和行号在仓外r4/reader/HANDOFF.md；旧current-candidates SQL在这些受guard的旧入口仍存在，target reader从不回退调用它。整体移除属于剩余消费者切换，不由B偷做。

## 查询计划与限制

本读域不新增索引。真实合成SQLite的trace/EXPLAIN记录实际使用的record_title_idx、difference_reason_impact_title_113_idx、record_correspondence_enterprise_idx、assignment复合PK、observation/enterprise PK，以及USCC覆盖索引扫描与UNION/ORDER BY临时B-tree。完整计划以同一最终tree的仓外reader/PLAN.json及REPORT为准。normalize-USCC两侧函数匹配仍可能扫描，mask bit过滤也不承诺索引seek；不为tinyfixture推导真实加速或新增影响全库写入的表达式索引。真实性能、HTTP/MCP/工作簿整体target接入及生产仍未接受。
