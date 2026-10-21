# 后台任务页面接入契约（#120 / #116）

统一入口 `/tasks`，导航位于后台管理。沿用现有 `job` 表、runner、鉴权和平台批次重试，不新建队列。

## URL 与生命周期

- `tab=all|ocr|platform|export`；`state=all|queued|running|done|failed|cancelled`。
- `page` 默认 1；`pageSize` 默认 25，最多 200；`job` 是服务端 ULID，独立读取详情，不要求任务在当前页。全部/导出 Tab 支持 `titleCode=little_giant|specialized_sme|innovative_sme` 称号筛选。
- 分类/状态切换回到第一页并关闭详情。刷新、浏览器返回、从结果入口返回均按 URL 重新读取。
- 前端每 3 秒读取；失败后 2/4/8/16/30 秒退避，保留最后成功结果及来源筛选/页码。离页只中止读取，不发送任务取消。
- 任务详情以右侧 Sheet 抽屉展示，手机全宽；正文独立滚动，底部保留间距。关闭后回到列表原操作位置，深链不要求任务在当前筛选中。
- 页面没有管理密钥表单，也不保存或发送 API 凭据。同源页面默认可操作，无需配置 API token；具体操作遵守任务状态及服务端逐任务能力。同源检查不是登录或用户授权。

## HTTP 安全摘要

- `GET /api/task-center?tab=&state=&page=&pageSize=` → `TaskList`（类型见 `lib/task-center.ts`）。计数应用状态筛选；列表使用稳定的创建时间/id 倒序分页。
- `GET /api/task-center/:id` → `TaskSummary`，增加有界 `items` 完整性/未完成位置，独立于原页面内存。
- `POST /api/task-center/:id/cancel` → `{ task, cancelRequested }`。排队取消 200；运行中请求取消 202，仍显示真实 running，直到终态。
- `POST /api/task-center/:id/retry` → 202。同平台批次 ID，仅委派原接口补查未完成项；保留其鉴权、终态校验及最多 10 次执行预算。无通用参数重放。重试若没有产出新结果（执行抛异常、排队时被取消、kind 未接入），摘要、逐项证据、未完成位置与执行计数都停留在最后一次检查点，只更新终态与错误；一次真正开始的执行会先落库递增后的 `attempt` 再发起平台请求，因此执行次数仍到达 10 次上限。依赖捕获（`prepare`）抛错时任务不重开：4xx 原样回 4xx，其余回 503 且原结果保留。注意平台 `prepare` 不会因凭据存储异常抛错（它降级为空 cookie，逐页记 `credential_unavailable`），那种情况仍是 202 的普通失败重试。
- 所有响应 `Cache-Control: no-store`。外部 API 操作继续使用 `NUXT_API_TOKEN` Bearer/X-API-Token。仅任务中心、三种当前名录导出及其产物允许带 `X-Task-Center-Browser: 1` 的同源浏览器请求：要求 `Sec-Fetch-Site: same-origin`；GET 要求同源 Referer，POST 要求精确匹配 Origin 及 JSON。不满足同源请求条件则回到原 token 校验，不改变 MCP 或其他写接口。
- SQLite 只投影元数据、标量和有界 ID/状态/位置；不把完整 params/result、OCR 文本、平台 segments/rows 取入列表 JS 内存。原始错误可能包含凭据或宿主路径，仅展示安全类别与操作建议。

## 分组与结果适配

- OCR：`ocr`、`render-pages`。结果链接通过成功产出的 fileId 查已登记的安全库内相对路径，进入既有识别校对页；不原样回放 params.files。
- 工信部平台：`platform-query-batch`、`reconcile`。批次显示逐项状态、完整性和未完成源/称号/页，核查显示报告计数。任务完成不代表业务判断完成；批次事实不声称正式入库。平台证据与比对入口保留，各自只展示原有业务范围。
- 未知类型仅出现在全部任务，以文本类型名称兜底；未知进度总量不造百分比。每种已知类型仅归一组。
- 首版 OCR/转图/核查不提供通用重提；提示到原业务入口核对后提交。只有公开能力为 true 的管理动作可用。

## #121 导出

- `TASK_GROUPS.export=['current-roster-export']`。`exportReady` 反映已登记 kind 是否 ready；页面读取 `/api/roster/exports/current/capabilities`，只启用真实公开的称号专用 POST 路由。通用 kind 支持三称号不代表三条专用路由均已上线。
- 三个独立入口按[导出共享契约](current-roster-export-contract.md)提交，收到 202 和 jobId 即返回页面操作。仅将请求身份（clientRequestId/已受理 jobId）放入 sessionStorage，断线、刷新和页内返回继续使用同一请求标识；不存 token、任务状态或产物内容。已受理入口显示“找回本次导出”；显式新导出由原任务详情“重新生成”提交新标识及 regenerateOf。
- `TaskSummary.export` 为有界白名单投影，包含称号、阶段、生成/快照时间、规则/数据版本、计数、原任务关联和受控产物摘要。产物 filename/downloadUrl 从称号/ULID 构建；每次列表/详情复用共享产物服务重查 available/expired/missing。历史 done 与当前可下载分别表示。
- `canDownload`/`canRegenerate` 按同源请求校验或 API token 及公开状态给出。取消仍走公共详情的真实请求/终态；导出不使用平台“重试未完成项”。失败和取消仅能显式新建关联导出。
- `TaskDetail` 默认插槽提供 `{task,current,refresh}`，页面通过插槽渲染产物，不另建详情轮询或取消状态。下载请求携带浏览器标记并通过同源请求校验，校验 HTTP、MIME、Content-Disposition、字节数和 SHA-256 后才触发保存；失败、取消、未完成、过期、缺失不启用下载。

保留期、重启和资源预算沿用 #117；未上线专用接口显示未上线，待 #118/#119 合入后按真实路由发现启用。三称号母规格验收须在三条接口全部交付后复验，不由小巨人单片结果替代。

生产导出能力发现使用公开只读的小清单，与生产 OpenAPI 默认关闭独立。清单来自实际构建路由，只启用存在且 kind 就绪的称号；缺项和发现失败均不可提交，不通过 POST 探测能力。
