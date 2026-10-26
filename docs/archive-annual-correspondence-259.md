# 归档受影响事件的年度任务（#259）

归档提交仍通过统一导入 API，native 导入进程只保存 candidateTaskIds，主进程收到 commit receipt 后交给既有候选 runner。候选任务按 query/身份/称号限定，冻结 throughEventId，每片最多 200 个已解析事件。

`candidate-discovery.ts` 消费这一片持久化 `result.items[].eventId`。候选片处理完成后，在同一 immediate 事务内调用正式 `stageAnnualCorrespondence(db, readAnnualWriteScope, {clientRequestId,eventIds})` 并保存候选检查点；stage 的内层事务是 savepoint。只有事务返回成功后才 `activateAnnualCorrespondence`，仍由同一串行任务 runner 执行。native 进程不会加载依赖 Nuxt `@db` 的 reader，适配器只在候选 runner 中延迟加载。

请求键是归档根 generation、候选片 jobId、冻结上界与事件集合的 SHA-256，固定长度 79，不随重试变化。年度 stage 再按完整事件来源 generation 和规则去重。公开采集快照不可变：同 query 坐标追加 sequence 必须拒绝，合法的新观察使用新的 queriedAt，产生新的 queryId。历史存储中同 query 已有新原行时，内部归档 stage 仍须创建新的根与 continuation generation，不能复用旧 DONE 续片。公开 DTO、任务 schema、年度规则及角色均未改变。

只有 query 范围的已解析事件会触发此接缝；显式 eventIds 和全称号候选请求不自动扩成年度扫描，空 scope 不提交任务。候选失败明细保持原样；年度任务仍独立报告来源超限等失败，不能用另一条任务的成功覆盖失败。候选取消在检查点停止，不再提交后续年度任务；已经提交的年度任务可通过其既有取消入口停止，重复收养不会重开 cancelled/done。

归档父事务回滚不留下任务。年度 stage 与候选 checkpoint 回滚也不留下年度 job。若进程在提交后、激活前死亡，年度 job 已持久化；既有启动对账把 queued/running 标为 failed，用户可显式 retry 同一年度 job。候选 retry 重放已绑定请求，不静默重开失败/取消的年度任务，不新增重复决定或审计。已完成的业务对应保留，人工 rejected/unlinked 始终由正式年度领域判断保护。

专项 `tests/archive-annual-correspondence.test.ts` 沿用真实 SQLite、正式年度 reader/domain/runner、统一导入 HTTP 和 native worker。#388 将年度来源回归分成两条，以下是初版静态候选的断言设计（该阶段未执行）；后续结果分阶段记录于下文：

- A 保留原 `401 affected events and appended same-query sources get complete new annual slices beyond old DONE continuations` 名称与 120000ms，成功路径只在 case 内把第二次 queriedAt 改为 `2026-10-24T00:00:01Z`，完整 raw 和 401 事件保留。仍沿真实 HTTP → native import → receipt → candidate → annual，重放复用保存的同一请求并核对完整回执、任务与审计。独立拒绝 case 验证原坐标 sequence2 的 preflight 冲突、commit failed/query_relation_set_conflict、written/skipped=0、failed=1、candidateTaskIds=[]，旧来源、投影、任务、对应和审计逐值不变。A 的 Q1≠Q2，不能据此声称验证同 queryId 续片碰撞。
- B `legacy-only same-query historical source state creates two complete 401-event annual generations` 明确使用获批的历史 source-only 合成造行例外。G1 三片 DONE 后，在隔离合成库同 Q 插入 BUS-2（申请、2024、2024-12-01、终审通过）的完整 raw；旧 query/raw/row1 保留。canonical 只能经既有 `platformRecordObservations` preflight/commit 投影，该请求没有 platformQueries，断言不会自动 stage。再于真实 immediate 事务内调用既有内部 `enqueueArchivedCandidates(..., true)`，事务提交后 `activateCandidateDiscoveryTasks`；年度片只由真实 candidate checkpoint 事务自动 stage/activate。第二代不是公共 append 成功或第二次 native 导入证据。

A/B 均要求两代 candidate 三片 DONE/items `[200,200,1]`、冻结上界 `eventIds[400]`、游标 `[0,eventIds[199],eventIds[399]]`，新链 ID 与旧链不交、children archiveGeneration 指向新根。各代年度三片尺寸 `[1,200,200]`，覆盖全部 401 事件；新代每 event 两个 outcomes、generation 改变、尾事件 R2 confirmed/context_only，G1 审计逐值保留。B 固定同 Q/H/游标并核对重复 stage 返回 G2、全部任务与审计全等；不直接构造 job/result/checkpoint/correspondence/audit/canonical 行，也不手调年度 stage 补漏。

结果历史：初版静态候选阶段，上述测试、setup/prepare、DB/SQL/probe、worker/runtime、build/type/full 和 mutant 均 UNRUN。随后首次三目标运行（test SHA `d8982117`）为 2 PASS/1 FAIL/11 filtered/exit1：A 与公开拒绝通过，B 在历史投影 preview 的四字段预期与正式六字段结果全等比较处失败。补全严格六字段预期、以独立固定 canonical literal 哈希后，2026-10-27 的 B-only 运行（test SHA `ce061772`）为 1 PASS/13 filtered/exit0。A 两项仅按旧运行与 case 块字节保全继承，本次未重跑；首次 FAIL 不被后续 PASS 覆盖。本结果段在 B 运行后补记，不属于运行输入；test 与其余运行源码保留运行字节，不能把包含后置文档的全部 1798 项冒称运行字节完全相同。wholefile/type/build/full/CI 与 mutant 仍 UNRUN，缺失的 unhandled/OS 资源数据保持 UNKNOWN。

原 full `123c3f2c` 的 5058 PASS/34 FAIL/19 SKIP/exit1、原 null-job 错误及其第二 receipt/root-vs-child UNKNOWN 均保留，候选不宣称修复 full。删除 continuation key 的 generation、以及同时删除 key/参数 generation 的检错映射由 B 承担，尚无实跑 RED；年度 digest 另含 candidateJobId，不宣称其 generation-only mutant 必红。后续执行须另获 slot，任何 unexpected FAIL 原样 STOP，不扩大原 timeout 或自动重试。

原检查点事务回滚、SIGKILL 恢复、幂等审计、人工决定与取消、空 scope 和大来源案例保持原字节。人工决定 `$name` case 的同坐标 append 观察属本票范围外，单列交父，不随本候选修正。SIGKILL 案例只在提交后激活边界注入进程死亡；大来源案例只观察 driver SQL，不替换领域端口。
