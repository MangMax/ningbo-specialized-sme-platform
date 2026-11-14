# 页面记录对应决定（#213）

从正式事件发现的候选只是只读建议，没有隐式保存。页面按当前状态提供确认/不对应，或取消/改选；已否定、已取消的决定只保留历史，不重新推荐。`existing_decision` 不是有效性证明，公开点读和原行上的 `requiresRevalidation` 仍决定是否可计为确认出处。来源变化后的确认复用领域守卫；已确认边可经同边 `correct` 重新核验，未改变的边不能用该入口重确认。

同源浏览器薄适配：

- `POST /api/roster/correspondences/browser-preflight`：`{idempotencyKey,basis,operations}`。
- `POST /api/roster/correspondences/browser-commit`：`{request:{idempotencyKey,basis,operations},planHash}`。
- `GET /api/roster/evidence-review/browser-context`：返回 `{writeEnabled:true}`，同源页面默认可提交，无需 API token 或页面复核开关；实际写请求仍执行精确 Origin、Sec-Fetch-Site 和 JSON 检查。外部 REST/MCP 写入继续使用独立 token。

请求体禁止 actor/sourceIdentity/ruleId/ruleVersion。适配器固定记录实际调用代理 `agent / same-origin-correspondence-adapter`，明确不识别个人身份；这不是用户登录或 #127 身份治理。规则是 `manual-source-row-review / 1`。凭证只留在服务端；表单仅收集业务依据与选定原行。

预检沿用现有领域计划账本，不提交对应业务行；提交绑定完整请求、来源指纹、当前状态与版本。网络失败保留原幂等键和计划；提交结果未确定时禁止编辑已提交的草稿。版本冲突必须刷新并重新核对，已变更状态不再允许旧操作。已提交但公开点读/审计/活动读视图同步失败时显示明确错误，只重试读回。相同事件/原行的发现刷新保留弹窗与草稿。

## 与 #214 的共享边界

`discoverEventArchives` 和发现的分页/历史决定规则保持不变。后台任务继续只经既有领域 preflight/commit 保存候选，不调用页面适配器，不覆盖人工决定。

仅两个相关领域补齐：

1. `create.status='rejected'` 在同一事务登记并否定尚未持久化的候选，追加 null→candidate→rejected 两条审计；REST/MCP共享该应用契约。无需先保存候选再另发决定。
2. `correct` 目标可以是尚无决定的新边，或来源指纹仍匹配的已登记 candidate。后者保持原目标 ID 与历史，原子解除 A、确认 B；目标版本/指纹绑定进 plan。已确认、驳回、解除的其他目标不会被复活。同一计划不能重复决定替换目标。来源漂移、并发和任何验证失败均不留下半完成替换。

活动的企业对应、原行及对比视图通过 `useCorrespondenceReadback` 加入提交后的显式读回，分别保留自己的加载/错误状态。对比读回保留当前原行弹窗；正常切换范围/分页沿用原有生命周期。跨路由重新进入仍读取公开 API。该通知限当前应用页，不对其他标签页宣称主动推送；其他标签页过期提交由领域版本保护。

此票不改变名单、平台原行、差异原因、任务适配器、job runner 或任务 UI，不授权生产写入。
