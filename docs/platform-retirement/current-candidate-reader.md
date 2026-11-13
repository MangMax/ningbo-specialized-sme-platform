# 显式目标候选 reader 与 current 引用水合

A sourcecapture 已独立接受。`createTargetCurrentCandidateReader(db)` 保留71609准入，并由 #762 延续到完成的71610至71613，返回 `iterate(title,sort?)`、`count(title)`、`page(title,offset,limit,sort?)`。无公开路由、环境 selector、旧表 fallback 或跨请求结果 cache；expand runtime guard 保持。page limit 为正 safe integer，offset 为非负 safe integer。

## 范围与归属

业务过滤只读 A 的 candidate_scope_mask/state。不能重算 requested/page/row title，不能调用 captureCandidateScope/candidateObservationValues，也不读取 page、三投影或 archive JSON 来计算候选。原collection/page/row关系与所有异常计数、JSON5/重复键语法已在A捕获，reader信任已接受71609的不可变结果。

后继准入在候选游标开始前检查已有 process 与后继 readiness、candidate 必要列及完成记录。随后核对 capture rule、mask 类型与范围、collection 的 rdjb/title、观察 sequence 及 sealed archive ID 绑定。这里只读取 collection 与 archive ref 的元数据，不解码归档、不重建迁移 hash 链，也不执行 capture 或 repair。不完整 catalog、capture 漂移及命中称号缺少 current assignment 均明确拒绝。

union 保留 record、difference_reason、record_correspondence（非空企业，包括原未确认/拒绝状态）与所有 scope 命中的 observation。后者读取同一 SQLite snapshot 内最大 assignment revision；显式 enterprise_id 优先，仅NULL时按旧 roster84_uscc(uscc_norm)=roster84_uscc(uscc_raw) 解析企业。保留旧空规范码、多原值归一到同一USCC等边界，不借用 projection/version 的USCC或 owner。无 key、未索引、无投影、pending、同版本多次观察均不作为排除条件；UNION负责企业PK去重。

uncaptured/error 不能当 mask0，读取前显式抛 TargetCurrentCandidateGap，带观察ID/state/reason。错误观察即使无可解析 owner，完整旧SQL仍可能在join短路前抛错，独立原SQL测试已证实；B不擅自把这种错误变为空集合。已捕获且本title bit未命中的观察不会因缺失assignment而阻塞该title；本title命中而缺assignment则明确报gap。缺assignment不等于已知无归属（有revision、enterprise_id为NULL）。

## ORM、迭代与 snapshot

union、最大revision、USCC条件、count、NOCASE排序与PK tie-break、limit/offset 全由Drizzle构造。ID升序；name升/降序都以PK升序稳定打平。count/page 使用同步事务，迭代复用调用者已有事务，否则拥有一段read transaction；正常耗尽提交、提前break/throw先finalize cursor再回滚自己拥有的transaction。不会提交/回滚调用者的outer transaction。

唯一窄例外：安装的 drizzle-orm0.45.4 better-sqlite3 PreparedQuery/session/select 没有可用同步streaming SELECT执行器（本机实际失败及sourcecapture证据保留）。iterator将完整ORM query的`toSQL()`交给同一connection的native prepare/iterate，只映射单列id；不手写或改写业务SELECT。使用`.all()`会失去#702的窄投影内存边界，分页重复枚举则改变#702单次枚举要求，因此两者均不采用。count/page仍用ORM执行API。BEGIN/COMMIT/ROLLBACK仅协调iterator生命周期，不构成业务SQL例外。

## 消费者接缝与后续

`CurrentCandidateReader` 定义iterate及只读connection identity；消费者拒绝跨connection注入。`listCurrentQualifiedWithCandidates` 与 `writeCurrentWorkbookWithCandidates` 提供显式依赖注入，使用同一connection/snapshot；原公开函数包装既有legacy provider，保持既有行为，未新增运行选择器。#702原Float64Array4096分块、五sheet上限、一次枚举后hydrate结构不变；#691assessmentReader/identity读取、asOf/规则版本、#687资格算法不改。

这些withCandidates函数仍有identity等旧路径，不是完整目标名单或导出入口。#731 B测试分别验证真实target候选与phase0既有assessment/workbook的注入契约。#762的同库组合证据如下；公开包装器与identity预扫描仍由后续票负责。R5/current-identity/H/C/X消费者明细和行号在仓外r4/reader/HANDOFF.md；旧current-candidates SQL在受guard的旧入口仍存在，target reader从不回退调用它。

## #762 完整 current 引用水合

显式 `createCurrentQualificationAssessmentReaderWithWitnesses` 的 `readCurrent` 与 `readWorkbook` 在目标路径复用 `readDifferencePlatformEffectsByTitle`。一次企业读取按已捕获的 candidate scope mask 分到三称号，保留 public relation/query alias 与 relation ID 顺序。status/year/batch 继续来自各 source owner 的 observation 投影。未归属 USCC 使用同一 snapshot 内最大 assignment revision 的原值，归一后可独立匹配多家企业。

这一批结果只属于单次完整水合。三个称号及共享的小巨人依赖复用它；下一次读取重新查询。原资格计算、规则版本、observations digest 的输入顺序及 serializer 不变。既有 correspondence fingerprint 校验仍由其 owner 读取原始 cell 归档；新增候选及 effects 业务路径不读取正文或 display JSON。

`tests/current-target-readers-762.test.ts` 重用一份真实完整迁移的71613 fixture，在自有副本物理移除两张旧表，再通过真实导入 owner 增加三称号、混合页与独立同版本观察。各 case 从这一基准 COPY0600。完整 readCurrent/readWorkbook 与 schema0旧服务及独立literal对照，检查原cells/history/receipts不变、public alias、scope、BLOB、hash与规则版本；并验证并发assignment的snapshot边界、iterator释放和请求内单次批量读取。

本轮仅交付本地候选。正常HTTP/MCP、identity预扫描、workbook worker、packaged job、全局runtime与实际退役操作未验收。#738–742未准入，整体#706仍为NOTREADY。

## 查询计划与限制

本读域不新增索引。真实合成SQLite的trace/EXPLAIN记录实际使用的record_title_idx、difference_reason_impact_title_113_idx、record_correspondence_enterprise_idx、assignment复合PK、observation/enterprise PK，以及USCC覆盖索引扫描与UNION/ORDER BY临时B-tree。完整计划以同一最终tree的仓外reader/PLAN.json及REPORT为准。normalize-USCC两侧函数匹配仍可能扫描，mask bit过滤也不承诺索引seek；不为tinyfixture推导真实加速或新增影响全库写入的表达式索引。真实性能、HTTP/MCP/工作簿整体target接入及生产仍未接受。
