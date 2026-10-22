# 运行日志来源与详情字段

本页是 #180 的来源/级别矩阵，供复核运行日志页与后续 instrumentation 使用。**运行日志只做运行诊断，不是业务审计**；对象事实仍以业务表/回执为准。

## 三个层次

| 层次 | 本仓库用法 | 例子 |
| --- | --- | --- |
| 原生 evlog 集成 | `evlog/nuxt` + `evlog.config.ts` 自定义 drain/redact；request hook 用 `event.context.log.set` 补 `requestId/traceId/route` | `http.request` 状态/耗时/模板 |
| 库 hook 薄适配 | 库本身没有 evlog 依赖，但有真实生命周期钩子；应用在钩子里只收集已允许字段 | `@tus/server` 的 `onIncomingRequest/onUploadCreate/onUploadFinish/onResponseError`；MCP toolkit 已原生写 evlog，应用只补 initialize 自报 |
| 应用领域日志 | 业务代码显式 `appLog`，字段由领域事实决定 | task/worker/platform/file/ocr/import/export/client/system |

`lib/logging/index.ts` 的 `appLog` 仍使用独立 evlog `createLogger`；它通过 `requestLogContext(event)` 复用 request 阶段的 `{requestId, traceId, mcp, tus}`。这不宣称 AsyncLocalStorage 会自动跨 worker 或子进程；异步任务/子进程必须显式传递允许字段。

## 来源 / 级别矩阵

`level` 只是严重度，不是结果。`outcome` 才是结果；`counts` 与真实存在的 `errorCode` 不因 level 或 success/started 被隐藏。

| 来源 | 真实 producer | 级别（常见） | 详情目标/字段 | 不适用时 |
| --- | --- | --- | --- | --- |
| `http` | evlog request completion；`core-route` 语义事件 | success/info；denied/warn；failure/error | `httpMethod`、`httpRoute`、`statusCode`、`durationMs`、`errorCode`（语义事件） | 不显示 file/page/batch/task 等来源字段；未匹配模板不猜 route |
| `mcp` | evlog request completion；toolkit `tagEvlogContext`；`server/mcp/index.ts` 工具语义事件 | success/info；denied/warn；failure/error | `mcp.transport/sessionMode/rpcMethod/tool`；initialize 另有 `client`（分类+可选版本）、`protocolVersionRequested`；`httpMethod/httpRoute/statusCode/durationMs/errorCode` | 非 initialize 不显示 client 缺失项；未知/批量 method 不冒充单个事实 |
| `task` | `job-store`、`job-runner` | started/info；failure/error；cancelled/info | `taskId`、`counts`、`durationMs`、`errorCode`、`requestId/traceId` | 不显示 file/page/batch |
| `worker` | `enterprise-read`、worker 子进程 | started/info；failure/error；exit unknown | `taskId`、`resourceType/resourceId`、`durationMs`、`errorCode` | 进程生命周期事件没有单 taskId 时明确说明，不伪造 |
| `platform` | `lib/platform/*`、平台批量查询 | success/info；partial/not_queried/warn；failure/denied/error | `batchId`、`page`、`counts`、`durationMs`、`errorCode`、`resourceType/resourceId` | 不显示 file/task 的无关字段 |
| `file` | tus middleware、登记、维护、解析、渲染、删除 | started/info；skipped/quiet；denied/warn；failure/error | `fileId`、`page`、`receiptId`、`counts`、`durationMs`、`statusCode`、`errorCode`；上传另有 `tus.*` | 上传事件不显示 fileId/page（尚未登记）；tus 缺失时说明可能创建前被拒 |
| `ocr` | `jobs/ocr`、页生命周期、结果写回 | started/info；cancelled/info；partial/warn；failure/error | `fileId`、`page`、`taskId`（有则）、`counts`、`durationMs`、`errorCode` | 不显示 batch/resource 等无关字段 |
| `import` | 提交/预检/执行/回执 | started/info；denied/warn；failure/error；unknown/warn | `batchId`、`receiptId`、`counts`、`durationMs`、`errorCode`、`resourceType/resourceId` | receipt 只在详情；不冒充已提交/已入库 |
| `export` | 旧同步导出、当前导出、产物清理/下载 | started/info；cancelled/info；denied/warn；failure/error | `taskId`、`resourceType/resourceId`、`counts`、`statusCode`、`durationMs`、`errorCode` | 不显示 file/page/batch 等无关字段 |
| `client` | 浏览器有限词汇上报 | 由上报 level 约束；固定 failure | `untrustedRelatedRequestId`（UNTRUSTED）、`requestId/traceId`、`errorCode`（interaction） | 不用客户端声称值当执行身份；不显示服务端对象字段 |
| `system` | 日志策略/清理；drain 故障只在 stderr | success/info；drain failure/error（仅 stderr） | `counts`、`resourceType/resourceId`（有则） | drain 故障不落 SQLite，页面不伪造历史 |

## MCP：原生集成 + 最小补采

已安装 `@nuxtjs/mcp-toolkit@0.24.2` 本身已有 evlog 集成：`getEvlogLogger(event)` + `tagEvlogContext` 会写入 transport、route、method(s)、request_id(s)、tool(s) 和可能的 session_id。**不应整包复制这个对象**：其中 request/tool/session 值来自客户端输入。应用的 `server/mcp/index.ts` 只在入口写一份 `applicationLogMcp`：

- `rpcMethod`：固定 allowlist；多项为 `batch`，未知为 `unknown`，不选一个代表整批。
- `tool`：只写静态注册表里存在的 tool 名；未知 tool 保留 `mcp.tool.unknown` 操作，不写 raw 名。
- `client`：只在 `initialize` 请求出现；`name` 按**精确 alias** 映射为 `claude/cursor/codex/vscode/cline/continue/inspector/other`，不存 raw name；`version` 只接受有界语义版本；`trust:'self-reported'`。
- `protocolVersionRequested`：仅接受 SDK `SUPPORTED_PROTOCOL_VERSIONS` 中的初始化请求声明，**不是服务端协商结果**。
- `sessionMode:'stateless'`：当前 toolkit 配置未启用 `sessions`，stateless 分支每次请求新建 server/transport。初始化请求的 clientInfo 不能跨调用继承；不建全局 session 缓存，不用 token/IP/UA/session 猜身份。

详情页只在 initialize 事件显示客户端字段和“自报、非鉴权身份”的说明；普通 tool 事件只显示 method/tool/sessionMode，不反复铺 client 的“未记录”。

## TUS：真实回调 + 请求局部 observation

`@tus/server@2.4.5` 的公开钩子被原样保留：

- `onIncomingRequest(req, uploadId)`：记录库生成的 uploadId 和方法；不解析 raw URL 取 id。
- `onUploadCreate`：业务 `landingSegments` 校验通过后记录 `created`、声明 size、offset。
- `onUploadFinish`：原 `mkdir`/`link`/`rm` 全部成功后记录 `completed`；不在钩子开始就判成功，也不改返回/错误/stream 语义。
- `onResponseError`：只记 `failed`，不读 raw error body；HTTP 发送断连不等于落位回滚。

`withTusObservation` 用窄 `AsyncLocalStorage` 把一次 `handleWeb` 绑定到一个新对象；不是 server 单例上的共享可变状态。uploadId 只接受默认生成器的 32 位小写 hex；不合格就省略，不让日志失败。size/offset 必须非负安全整数；未知 size 省略。事件策略：

- POST 创建未完成：`file.upload` + `outcome:started` + `tus.phase:created`。
- POST/PATCH 终态完成：`file.upload` + `success` + `tus.phase:completed`；同 uploadId 可串分片。
- 4xx：`denied` + `file_upload_rejected`；5xx/断连：`failure` + `file_upload_failed` + `tus.phase:request-failed`。
- 成功 HEAD、非终态 PATCH、OPTIONS、成功 DELETE 不写语义日志；DELETE 不被称作 finish。
- 上传完成与 `file.register` 业务登记成功是两条独立事件；不把上传完成等同入库。
- `/api/uploads` 由 middleware 截获，不经过 Nitro router；`httpRoute` 保持未知，不把具体 path 去 query 当模板，也不改 113 条 route whitelist。

## Better Auth 现状

- 已安装 `evlog@2.33.1` 提供 `evlog/better-auth` 的 `identifyUser()` / `createAuthMiddleware()` / `createAuthIdentifier()`；它需要真实 Better Auth 实例和 session。
- 本应用**没有 better-auth 依赖**，也没有登录会话；`server/utils/api-auth.ts` / `mcp-auth.ts` 是 token 能力判据，不是用户身份。`evlog/better-auth` 因此未接入，也不应安装或伪造用户身份。
- 当前能记录的是 MCP 客户端在 initialize 的**自报分类**，不是登录用户，也不是鉴权身份；不要把它写进 `user`/`actor` 或业务审计。
- 将来接入 Better Auth 时，应在真实 session 解析成功后调用 `identifyUser(log, session)`（或 `createAuthMiddleware`），并继续走本页的隐私投影；在完成前保持现状。

## 其他库

- ExcelJS：devDependency，未发现 evlog 依赖或内置 logger API；导出领域事件由应用 `appLog` 记录，不能期待库自动上报。
- Documonster：应用库，未发现 evlog logger；只记录应用显式事件。
- `worker_threads`：Node 原生，不自动继承父进程 AsyncLocalStorage/evlog 上下文；任务/子进程事件必须显式序列化允许字段。

## 已知限制

- MCP clientInfo 只在 initialize 自报；stateless 后续调用不可得，页面不把它当身份。
- `protocolVersionRequested` 不是协商结果；当前没有从响应捕获协商版本。
- TUS 失败事件的 offset 可能未知（库的 POST_RECEIVE 有节流，短请求可能尚未产生 tick）；未知就省略。
- `logging.drain` 故障只写 stderr，不进入 SQLite；这是日志不可用时的隔离设计，不伪造历史。
- 既有 export ECONNRESET 基线保持 `UNKNOWN`，本页不声称修复。
