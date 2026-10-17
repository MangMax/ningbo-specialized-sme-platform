# 外部服务凭据配置

后台导航「后台管理 → 密钥配置」管理在线 OCR token 和工信部平台 Cookie，各平台独立保存到应用 SQLite 的 `service_credential` 表。进入页面读取遮罩状态，无需输入 API 管理 token。查看/复制原值由用户显式操作；原值仅保存在页面内存，离开清理，不使用 URL、localStorage 或 sessionStorage。现有任务等其他接口仍沿用 `NUXT_API_TOKEN` 授权。

页面按 OCR／工信部平台 Tab 切换。切换保留各自未保存的输入，已显示的原值重新隐藏。复制结果通过 Sonner 提示。保存不验证外部服务可用性，不自动发起 OCR、登录、刷新会话或启动核查。

## 数据库存储与部署

复用应用已有 `NUXT_DB_PATH` 指定的 SQLite，默认 `<cwd>/data/roster.db`，不需要额外凭据目录或配置文件。首次通过可写连接打开数据库时，现有 Drizzle 迁移机制自动创建 `service_credential` 表；字段为 `key`、`value`、`updated_at`。更新按主键 upsert，清除按主键删除，多字段更新在同一事务内完成；失败回滚，不影响另一个平台。

凭据当前以可读值保存在凭据表中，不作为任务参数、任务历史、查询证据、日志或普通 Excel 台账导出的内容。SQLite 的完整备份包含凭据，应按敏感数据保护并限制数据库访问；容器继续持久挂载应用数据库卷即可。恢复数据库后保存值随之恢复。只读数据库可读取已有配置，保存或清除返回 503。

旧版凭据 JSON 存储、专用目录变量及 Cookie 文件回退均已移除，不自动读取或导入旧配置文件。升级后需要在页面重新保存原先只存于旧文件的值；环境变量仍作为回退。

数据库读取失败时返回通用错误，不悄悄回退到环境变量。多个连接通过 SQLite 事务和主键更新避免互相覆盖；SQLite 文件的并发与部署限制仍遵循应用数据库本身的要求。演示数据库生成脚本会清除凭据表并清理残留页空间。

## 生效规则

- OCR：程序内部显式 override → 数据库保存值 → `NUXT_OCR_TOKEN` → `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`。
- 工信部 Cookie：程序内部受控显式 override → 数据库保存值 → `MIIT_COOKIE`。
- 独立 CLI 仅使用 `MIIT_COOKIE` 或受控注入值，不读取应用保存的凭据。

保存后无需重启，新任务提交时读取当前值，并在进程队列内保留提交时快照。后续修改不影响排队或运行中的任务，也不把快照写入任务历史。OCR 提交和轮询使用同一快照；reconcile 一次任务的所有企业、槽位及重试也使用同一快照。服务重启后旧队列按既有中断失败规则处理，新任务读取数据库保存值。清除只删除数据库覆盖值，不修改部署环境。

默认只返回遮罩：长度不超过 8 字符全部隐藏，否则只露首尾各 3 字符。显示/复制按需读取完整值；复制不改变遮罩展示。原值及其编码回显在外部响应、错误和任务结果持久化前脱敏。会话过期、登录页、权限和网络问题仍归为查询失败，正常结构的空响应才是无记录。

## HTTP 契约

配置接口无需管理 token，所有响应 `Cache-Control: no-store`。错误不回显输入凭据、SQL、路径或底层异常。没有可读回凭据的 MCP 工具。

- `GET /api/settings/credentials`：返回 `{ ocrToken: { configured, source, masked, updatedAt, hasSaved }, miitCookie: { ...同形状态 } }`。OCR 的 source 为 `saved`、`NUXT_OCR_TOKEN`、`PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN` 或 `none`；Cookie 为 `saved`、`MIIT_COOKIE` 或 `none`。时间来自数据库保存值。
- `PATCH /api/settings/credentials`：`{ ocrToken?: string, miitCookie?: string }`。省略保持不变；拒绝空白、非字符串、超过 65536 字符和未知字段；Cookie 另拒绝换行。整个请求校验通过后才进行事务更新，返回遮罩状态。
- `DELETE /api/settings/credentials`：`{ key: "ocrToken" | "miitCookie" }`，必须显式指定，返回清除后的遮罩状态及回退来源。
- `POST /api/settings/credentials/ocrToken/reveal`：显式查看/复制，返回 `{ value: string }`；无值为空字符串。
- `POST /api/settings/credentials/miitCookie/reveal`：同样返回完整 Cookie，不启动任何平台查询。

输入无效 400，方法不支持 405，数据库存储不可用 503。原值不得加入 SSR/初始化 payload 或缓存。OpenAPI 仅开发期暴露，生产默认关闭。
