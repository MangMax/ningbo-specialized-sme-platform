# 年度自动对应与任务（#251）

本模块消费 #250 的完整年度共享读模型；不会重写平台原行、版本、proof 或旧候选任务。年内早期失败/退回仍可创建 `event_process/context_only` 过程对应。末态相符只是事实资格；当前实际选定版本的有效 confirmed 决定且无保护性决定才有 final。决定始终列出其实际 relationId，不表示同版本其他观察已确认。

公共 DTO：`lib/roster/annual-correspondence.ts`。任务 kind `event-annual-correspondence`，专属 rule `event-annual-process` / version `1`。执行 outcomes 是历史检查点；当前资格须读 `finalQualification`。

- `POST /api/roster/events/:id/annual-correspondence-tasks`：`{clientRequestId}`。页面不发送 token，服务端使用 默认启用的精确 Origin、Sec-Fetch-Site 与 JSON 校验；REST 使用 API token。
- `POST /api/roster/annual-correspondence-tasks` 批量入口使用相同 worker、显式 `eventIds`（1..200）与 `clientRequestId`；不扫描全库。
- `GET /api/roster/annual-correspondence-tasks/:id`：`AnnualTaskDto`，`status` 沿用 JobState，`result.events[]` 逐事件保存 generation、执行状态、历史 outcomes 和当前 finalQualification。GET 不预检、不入队、不写 job/ledger/audit，不调用启动对账。
- `POST .../:id/cancel`：返回 `{jobId,state,cancelled,cancelRequested?,alreadyFinished?,note}`；停止在检查点，保留已完成业务。
- `POST .../:id/retry`：返回 `AnnualTaskReceipt`，同 jobId、最多10次执行，保留已完成业务。来源代次改变必须新请求；不复用旧完成 continuation。
- MCP：`submit_event_annual_correspondence_task`、`get_event_annual_correspondence_task`、`cancel_event_annual_correspondence_task`、`retry_event_annual_correspondence_task`；写工具使用独立 MCP token，业务同义。

同 clientRequestId 永久绑定规范化 eventIds；来源变化也返回旧 receipt（未知结果可沿原 key 安全重放），改 eventIds 返回409。服务器另以完整 event/generation 集合和年度规则形成稳定身份，新 clientId 刷新同一代次仍复用任务。新来源集合形成新代次。单事件 receipt 也有 `sourceGenerations:[{eventId,generation}]`。

旧任务 GET 比较当前完整 scope generation 和保存的 event generation；不同则 `finalQualification={stepId:null,status:'blocked',reasons:['source_generation_changed'],decisionRefs:[]}`。不能把旧 DONE 任务画成新来源已核对。当前年度视图的只读 enrichment 由 `enrichAnnualProcessFinalQualification` 提供，完整计算后才展示分页。

每次写一个业务前在 immediate 事务内重读完整年度范围及实际决定。跨版本 rejected/unlinked/改选保护不静默复活；同选定版本已有有效观察决定仅读回其出处，不多写同义边。新版本独立校验，不继承旧 proof。候选确认带 expectedRevision，新增对应和审计只走既有 typed-edge preflight/commit。sourceForEdge 原守卫保留，4MiB 单来源水合界限保留；失败不改写为成功。

内部接缝：

```ts
stageAnnualCorrespondence(db, readAnnualWriteScope, {
  clientRequestId, eventIds, // 1..200个已知受影响事件
}): AnnualTaskReceipt
activateAnnualCorrespondence(db, readAnnualWriteScope, ids, filesDir): void
```

stage 自带 immediate 事务，可嵌入上层归档事务形成 savepoint；只落库/去重，不激活 runner，不启动对账。父事务回滚时 job 与幂等绑定一起回滚。activate 必须在成功提交 receipt 后调用；只收养 queued 任务，重复激活不重开 done。服务启动时由专属薄 plugin 注册年度 JobSpec 并调用既有 runner 对账（只读库跳过写对账）；进程中断任务标为失败，再显式 retry；领域 commit 后 checkpoint 前的中断通过重读既有决定恢复，不重复审计。

自动归档接线由父票独立窄组合切片负责。本片只交付显式受影响 eventIds 能力，未修改 roster-import/import-execution/candidate-discovery，不能将其视为自动归档增量验收。旧 comparison 的年度消费仍由外部 owner 协调，本片只输出年度语义和实际资格，不覆盖旧观察输出。
