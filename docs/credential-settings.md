# 外部服务凭据配置

后台导航「后台管理 → 密钥配置」管理在线 OCR token 和工信部平台 Cookie，各平台独立保存。进入页面自动读取遮罩状态，无需输入 API 管理 token。查看/复制原值仍由用户显式操作；原值只保存在当前页面内存，离开清理，不使用 URL、localStorage 或 sessionStorage。现有任务等其他接口仍沿用 `NUXT_API_TOKEN` 授权。

页面按「OCR」和「工信部平台」Tab 切换，每次只展示当前平台配置。切换保留各自未保存的输入，已显示的原值会重新隐藏。

## 部署、备份与恢复

必须指定 `NUXT_CREDENTIALS_STATE_DIR` 为仓库外的绝对路径，例如容器 `/var/lib/ningbo-credentials`，将该目录挂载为持久卷。不给该变量时仍可使用原有环境凭据，但页面保存/清除返回存储不可用。目录由容器运行 UID 持有，建议权限 0700；新文件 `credentials.json` 和临时文件为 0600。不要把它 COPY 进镜像、放入文件库、业务 SQLite、Git 或普通数据导出。

例如 Docker 使用 `--mount type=volume,source=ningbo-credentials,target=/var/lib/ningbo-credentials -e NUXT_CREDENTIALS_STATE_DIR=/var/lib/ningbo-credentials`。停止服务后按敏感配置单独加密备份整个目录；恢复时停止写入，替换目录并恢复运行 UID、0700/0600 权限，再启动服务。不要将原文打印到日志。容器重建继续挂载同一卷。

文件采用同步读改写、同目录独占临时文件、fsync 与原子 rename；写入失败不替换旧文件，操作报错并可重试。读取损坏/不可读文件时失败关闭，不悄悄退到环境凭据。一个 state 目录仅支持一个应用写入进程；不要由多个容器或 Node worker 并发写同一目录。应用进程内各配置更新串行，不会因省略字段清除其他配置。未来增加凭据字段应复用这个文件与服务边界。

## 生效规则

OCR 有效值：程序内部显式 override → 页面保存 → `NUXT_OCR_TOKEN` → `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`。页面显示来源；清除仅移除页面覆盖值，不修改进程环境或部署 env。保存代表「已配置」，不代表验证通过，不会自动发起付费 OCR 或重跑任务。新任务立即读取当前配置；任务在提交入队时把有效值保留在仅进程队列持有的内存快照中，提交和轮询不因后续修改而改变。上传 OCR 结果、文件上传、页图渲染仍无需在线 token。

平台 Cookie 有效值：程序内部受控显式 override → 页面保存 → `MIIT_COOKIE` → `MIIT_COOKIE_FILE`。应用联网查询与 reconcile 使用 `resolvePlatformCookie` 统一边界；reconcile 一次任务的所有企业、槽位与重试固定同一快照。独立 CLI 保留原有环境/文件读取语义，不依赖 Nuxt 或配置服务，文件不存在按无值处理，不可读明确失败，不修改外部文件。保存不会登录、刷新会话或批量核查，也不代表会话可用；过期、登录页、权限及网络失败仍是查询失败，真实结构正常空响应才是无记录。返回证据前对成功原始响应、字段和错误中的当前凭据回显脱敏。新值不影响排队或运行中的旧任务；取消、结束或重启后不恢复队列凭据，重启后旧队列按既有中断失败语义处理。

默认只返回服务器遮罩；长度不超过 8 字符时全部隐藏，否则仅露首尾各 3 字符。显示/复制按需发起受保护请求；隐藏移除原值，复制原值不改变遮罩展示。离页清理内存；浏览器剪贴板由用户显式复制写入。

## HTTP 契约

本节配置接口无需管理 token，所有响应 `Cache-Control: no-store`。错误仅返回通用消息，不回显请求体、凭据或磁盘路径。没有可读回凭据的 MCP 工具。

- `GET /api/settings/credentials`：返回 `{ ocrToken: { configured, source, masked, updatedAt, hasSaved }, miitCookie: { ...同形状态 } }`。`source` 是 `saved`、`NUXT_OCR_TOKEN`、`PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN` 或 `none`；Cookie 来源为 `saved`、`MIIT_COOKIE`、`MIIT_COOKIE_FILE` 或 `none`；时间仅来自保存值。
- `PATCH /api/settings/credentials`：JSON `{ ocrToken?: string, miitCookie?: string }`。省略保持不变；拒绝空白、非字符串、超过 65536 字符和未知字段；Cookie 额外拒绝换行。返回最新遮罩状态。
- `DELETE /api/settings/credentials`：JSON `{ key: "ocrToken" | "miitCookie" }`，必须显式指定。返回清除后的遮罩状态及回退来源。
- `POST /api/settings/credentials/ocrToken/reveal`：显式查看/复制，返回 `{ value: string }`；无值为空字符串，不触发 OCR。
- `POST /api/settings/credentials/miitCookie/reveal`：同样使用 no-store，返回当前有效完整 Cookie，仅供显式查看/复制，不启动查询。

输入无效 400，方法不支持 405，持久存储不可用 503。原值响应不得缓存、记录或加入 SSR/初始化 payload。OpenAPI 继续仅开发期暴露；生产默认关闭。
