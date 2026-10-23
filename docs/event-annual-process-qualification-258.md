# 单事件年度资格同快照读取（#258）

GET `/api/roster/events/:id/annual-process` 和 MCP `get_event_annual_process` 共用 `event-annual-process-api.ts`。成功响应在完整年度事实读取后附 `process.finalQualification`，再截 `process.steps` 展示分页。响应字段、参数和错误信封沿用 #250；没有新写入口或参数。

共用 API 在同一个外层 SQLite 读事务中执行：

```text
readEventAnnualProcess(db, eventId)        // 完整scope
  → enrichAnnualProcessFinalQualification(db, read)
  → 读事务结束
  → 分页展示steps
```

保留 #251 helper 自身的只读事务及完整scope重读校验，不移除双读。sourceGeneration/sourceRefs/latestStepSummary均来自同次完整scope；页外final可通过summary及其实际decisionRefs说明，不从当前展示页猜资格。

`finalCandidateStepId`仍只表示年度事实候选。`finalQualification.status`表示该读快照中的实际资格：`confirmed`须有选定当前版本的有效确认出处，`eligible`仍待决定，`blocked`保留保护性决定/来源失效等原因，`none`没有可确认末态。各decisionRefs只代表自己的实际relationId，不把同版本其他观察称为已确认；历史任务DONE不能代替当前决定。

独立调用enricher时，若旧read之后另一连接提交了更晚业务，helper返回旧source集合及 `blocked/source_generation_changed`，不把新final附给旧scope。通过公开API时，外层读事务保持范围与实际决定的一致快照：另一WAL连接在两次读之间提交较晚业务或人工unlink，不会混入本次结果；下一次GET才看到新代次或新决定。相同sourceGeneration也不代表决定未变。

GET/MCP不调用preflight、stage、reconcile或runner，不创建job、ledger、审计或proof。支持真正readonly/query_only连接。本片仅接线共用API，不修改年度纯规则、领域写守卫、资格helper、归档触发或UI。

直接证据见 `tests/event-annual-process-qualification.test.ts`（实际资格、分页、两连接竞态、query_only零写）及 `tests/event-annual-process-qualification-http.test.ts`（真实只读Nuxt GET/MCP的confirmed/blocked/none及原决定出处）。生产数据核查仅在SQLite `.backup` 创建的独立副本上读取，不复制含WAL的main文件，不写原共享库/生产。
