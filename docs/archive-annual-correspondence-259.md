# 归档受影响事件的年度任务（#259）

归档提交仍通过统一导入 API，native 导入进程只保存 candidateTaskIds，主进程收到 commit receipt 后交给既有候选 runner。候选任务按 query/身份/称号限定，冻结 throughEventId，每片最多 200 个已解析事件。

`candidate-discovery.ts` 消费这一片持久化 `result.items[].eventId`。候选片处理完成后，在同一 immediate 事务内调用正式 `stageAnnualCorrespondence(db, readAnnualWriteScope, {clientRequestId,eventIds})` 并保存候选检查点；stage 的内层事务是 savepoint。只有事务返回成功后才 `activateAnnualCorrespondence`，仍由同一串行任务 runner 执行。native 进程不会加载依赖 Nuxt `@db` 的 reader，适配器只在候选 runner 中延迟加载。

请求键是归档根 generation、候选片 jobId、冻结上界与事件集合的 SHA-256，固定长度 79，不随重试变化。年度 stage 再按完整事件来源 generation 和规则去重。同 query 新原行创建新归档根与 continuation generation，不能命中旧 DONE 的请求键。公开 DTO、任务 schema、年度规则及角色均未改变。

只有 query 范围的已解析事件会触发此接缝；显式 eventIds 和全称号候选请求不自动扩成年度扫描，空 scope 不提交任务。候选失败明细保持原样；年度任务仍独立报告来源超限等失败，不能用另一条任务的成功覆盖失败。候选取消在检查点停止，不再提交后续年度任务；已经提交的年度任务可通过其既有取消入口停止，重复收养不会重开 cancelled/done。

归档父事务回滚不留下任务。年度 stage 与候选 checkpoint 回滚也不留下年度 job。若进程在提交后、激活前死亡，年度 job 已持久化；既有启动对账把 queued/running 标为 failed，用户可显式 retry 同一年度 job。候选 retry 重放已绑定请求，不静默重开失败/取消的年度任务，不新增重复决定或审计。已完成的业务对应保留，人工 rejected/unlinked 始终由正式年度领域判断保护。

专项 `tests/archive-annual-correspondence.test.ts` 使用真实 SQLite、正式年度 reader/domain/runner、统一导入 HTTP 和 native worker，覆盖 401 事件与追加同 query 原档、检查点事务回滚、真实 SIGKILL 后恢复、幂等审计、人工决定与取消、空 scope 和大来源失败。SIGKILL 案例只在提交后激活边界注入进程死亡；大来源案例只观察 driver SQL，不替换领域端口。
