# 后台任务页面接入契约（#120 / #116）

统一入口 `/tasks`，导航位于后台管理。沿用现有 `job` 表、runner、鉴权和平台批次重试，不新建队列。

## URL 与生命周期

- `tab=all|ocr|platform|export`；`state=all|queued|running|done|failed|cancelled`。
- `page` 默认 1；`pageSize` 默认 25，最多 200；`job` 是服务端 ULID，独立读取详情，不要求任务在当前页。
- 分类/状态切换回到第一页并关闭详情。刷新、浏览器返回、从结果入口返回均按 URL 重新读取。
- 前端每 3 秒读取；失败后 2/4/8/16/30 秒退避，保留最后成功结果及来源筛选/页码。离页只中止读取，不发送任务取消。
- 管理 API 密钥由操作者输入，限当前页面内存及请求头；不进入 URL、存储或构建产物。离页/刷新清除。服务端密钥不下发。

## HTTP 安全摘要

- `GET /api/task-center?tab=&state=&page=&pageSize=` → `TaskList`（类型见 `lib/task-center.ts`）。计数应用状态筛选；列表使用稳定的创建时间/id 倒序分页。
- `GET /api/task-center/:id` → `TaskSummary`，增加有界 `items` 完整性/未完成位置，独立于原页面内存。
- `POST /api/task-center/:id/cancel` → `{ task, cancelRequested }`。排队取消 200；运行中请求取消 202，仍显示真实 running，直到终态。
- `POST /api/task-center/:id/retry` → 202。同平台批次 ID，仅委派原接口补查未完成项；保留其鉴权、终态校验及最多 10 次执行预算。无通用参数重放。
- 所有响应 `Cache-Control: no-store`。无鉴权只能读；操作继续使用现有 `NUXT_API_TOKEN` Bearer/X-API-Token 边界，401 不绕过。
- SQLite 只投影元数据、标量和有界 ID/状态/位置；不把完整 params/result、OCR 文本、平台 segments/rows 取入列表 JS 内存。原始错误可能包含凭据或宿主路径，仅展示安全类别与操作建议。

## 分组与结果适配

- OCR：`ocr`、`render-pages`。结果链接通过成功产出的 fileId 查已登记的安全库内相对路径，进入既有识别校对页；不原样回放 params.files。
- 工信部平台：`platform-query-batch`、`reconcile`。批次显示逐项状态、完整性和未完成源/称号/页，核查显示报告计数。任务完成不代表业务判断完成；批次事实不声称正式入库。平台证据与比对入口保留，各自只展示原有业务范围。
- 未知类型仅出现在全部任务，以文本类型名称兜底；未知进度总量不造百分比。每种已知类型仅归一组。
- 首版 OCR/转图/核查不提供通用重提；提示到原业务入口核对后提交。只有公开能力为 true 的管理动作可用。

## #121 导出适配点

目前 `TASK_GROUPS.export=[]`，`TaskList.exportReady=false`，导出 Tab 准确显示尚未就绪，无提交表单/下载承诺。#117 的 kind 在显式适配前仍可在全部任务看到，不会丢失。

#121 在 `pages/tasks.vue` 的 export 提示处接入提交表单；在 `lib/task-center.ts` 登记 #117 实际公开 kind，在 `server/utils/task-center-http.ts` 增加白名单产物摘要及其公开操作能力，替换 exportReady。产物 ID/可用性/下载、重新生成与权限须采用 #117 的实际契约，不按 done 或通用 params 推断。不要修改本票之外的 runner/specs 来伪造能力。
