# 关联办理本地查询（#458）

本层消费 #457 的 `platform_business_projection`，提供只读的本地关联办理 HTTP/MCP 查询与最小页面。只覆盖 `business_list`（上游 `businessList`）；不迁移 `apply_list`/`recognized_list`，不访问外部平台，不写业务数据，不实施年度 final 算法。

## 查询入口

| 入口 | 契约 |
|---|---|
| `GET /api/platform/business-processes` | 等价 MCP `list_platform_business_processes`。 |
| `GET /api/platform/business-processes/{recordId}` | 等价 MCP `get_platform_business_process`。 |
| 页面 `/platform-business-processes` | 侧边栏「关联办理」入口；筛选、分页、观察与版本详情。 |

公共筛选：`view=records|isolated`（默认 records）、`q`（企业名称/统一社会信用代码关键词，只通过已归属观察匹配）、`enterpriseId`、`platformKey`（精确办理编号）、`rdjb`（来源查询的显式称号范围 1/2/3）、`declareKind`（事项；已知 申请/更新/复核 归一为 apply/update/review 后匹配，字典外原值保留）、`year`（来源明确业务年）、`status`（原 `cszt`）、`batch`（原 `whpc`）、`page`、`pageSize`（最多 200）。

- **称号范围是查询事实**：`rdjb` 只匹配该记录实际观察到的来源查询的显式 `platform_query.rdjb` / `platform_query_title_scope`，不写入内容版本、不当作逐行称号。页面与详情显示「称号范围（查询事实）」，不把查询范围升格为正式称号事实。
- `records` 按业务记录组织：同一 `platform_business_record` 的匹配内容版本压缩为一行，返回匹配版本、匹配版本数、全部版本数、观察数、最近采集时间、企业归属、观察到的称号范围与冲突。匹配版本按 `applied_at` 最新（缺失最后）再按 `version_id` 选择；不代表正式结论或时间顺序。尚未建立 typed 投影的历史内容版本仍以空字段出现并明确标注；不因回填未执行而从查询面消失。
- `isolated` 单独列出 `missing_key`、`conflict`、`unverifiable` 或无版本的办理观察，不并入任何记录；仍按原 `relationId` 可定位。`apply_list` 同编号记录不会出现在本查询中（同编号跨接口不合并）。
- 未知 `sblx`/`year`/`cszt`/`whpc` 保持 null/原值；不从 `sqsj`、`queriedAt`、批次或名称推年份/称号，不跨接口合并。

## 详情边界

详情返回记录身份、全部内容版本（最多 100）和实际观察元数据（最多 200），包括版本 typed 字段、版本的观察称号范围、版本哈希、观察的 relation/query/采集时间/企业归属/identity/content 状态、版本引用、查询称号范围，以及**该观察自己的对应决定引用**（id/status/revision，不返回决定内容、不传播到其他观察）。超出上限时 `counts.versionsTruncated`/`observationsTruncated=true`，不静默截断。**不返回 raw JSON**；原档仍走 `/api/platform/queries/{queryId}/evidence`，页面可按原行展开已有的 `RecordSourceReader`。

## 预算

- 列表只查 `platform_business_projection` 与既有索引列；企业关键词通过已归属 observation/relation/enterprise 做 `EXISTS`，称号范围通过 `platform_query`/`platform_query_title_scope` 做 `EXISTS`（不 JOIN，避免行倍增），不扫描 raw。
- 每页最多 200 个业务记录；详情最多 100 个版本和 200 次观察；计数另查。详情的称号范围查询只针对实际返回的 ≤100 个版本和 ≤200 次观察的 query id，不读取该记录的全部历史版本。
- 稳定排序：记录按最近采集时间倒序、ID 倒序；版本按版本 ID 倒序；观察按采集时间倒序、relation ID 倒序。
- 失败返回 400/404；不会把失败或无记录混成空结果。

## 真实消费者

两个既有入口：

- `/platform-queries` 的查询卡片：`business_list` 查询新增「本地办理记录」链接，携带该查询的 `queryKey`（USCC）预填 `q` 进入本地查询；证据读取器、原展示文字与分页不变。
- 企业详情/比对的平台证据表（`components/PlatformRecords.vue`）的 `business_list` 行动作列新增「本地办理记录」链接，携带精确 `platformKey`；原展示文字、行分组、对应事件/出处与来源阅读器均不变。

页面读取 `q`/`platformKey` 路由参数预填筛选并执行一次查询；MCP 工具与 REST 共用同一领域读服务。`/platform-queries` 本身只渲染查询证据，不渲染该记录表，因此两处入口都按各自可见的坐标链接。

## 影子对照（同一隔离 SQLite，同一观察）

对照对象：旧企业详情平台业务读路径 `readPlatformBusinessDetails`（按关系观察分组成 `PlatformBusinessDetail`）与新 `listPlatformBusinessProcesses`/`getPlatformBusinessProcess`。输入为同一隔离库内同一企业的 6 次 `business_list` 观察：K1 同内容重放 2 次（1 版本 2 观察）、K2 单次（称号范围 `1,3`）、一条缺编号观察、一条编号冲突观察，并为 K1 的一条原行写入对应决定 #1。

| 对照项 | 结果 |
|---|---|
| 记录身份（platformKey / interface / recordId） | 一致，无差异 |
| 版本数 / 观察数 | 一致，无差异 |
| 观察 relationId 与版本 versionId 定位 | 一致，无差异 |
| 分页（pageSize=1 的两页）与 `platformKey` 筛选 | 与旧 reader 的成员集合一致 |
| `rdjb` 筛选 | 新 reader 的标题范围过滤结果与旧 reader 的称号观察子集一致；匹配版本也只取该范围内的版本 |
| 缺编号/编号冲突观察 | **已批准语义差异**：旧路径按 relation 独立成一条业务详情；新路径不并入任何记录，只在 `view=isolated` 单列（2 条） |
| 查询称号范围 | **新增字段**：旧 DTO 无逐记录称号范围；新读路径显式返回查询事实，不冒充行称号 |
| typed 业务字段 | **新增字段**：旧 DTO 无 `businessYear`/`batch`/`awardBatchLabel`/`province` 等 typed 访问；新路径只从内容版本投影返回 |
| 对应决定 | 两路径都保留原行的决定引用；新路径只返回该观察自己的 id/status/revision，不把决定传播到其他观察，也不返回决定内容 |
| 旧 ID / 审计 | 两路径均不改写 |

对照测试：`tests/platform-business-processes-shadow.test.ts`。记录集合、计数、relationId/versionId、分页、筛选与决定定位均用直接断言；`differences` 只列已批准语义差异，新增字段单列说明。差异清单不把新 reader 自身当唯一 oracle。

## 验收边界

- 真实隔离 SQLite + 公开 REST/MCP handler：筛选（企业、编号、称号范围、事项、业务年、状态、批次）、分页、未知值、缺编号隔离、跨接口同编号不合并、历史版本、无 raw 泄露、非法输入与 404；详情 100 版本 / 200 观察截断与响应体量。
- 页面组件覆盖记录表/隔离表/详情/原行展开；页面用例覆盖既有入口 `q`/`platformKey` 预填、筛选、视图切换、分页、空态与失败重试。
- 人工操作记录（2026-11-03，集成分支 `pnpm dev` 构建产物；隔离临时库，经公开导入提交 2 条已投影记录 + 1 条缺编号观察）：
  - **1280px**：导航「关联办理」可达；称号范围/事项/业务年/状态/批次筛选与重置可用；记录表 10 列在内容宽度内完整显示（办理时间显示日期，完整时间在详情）；分页每页条数可切换；「观察与版本」打开详情，记录身份、内容版本、查询称号范围、原认定批次标签、观察表与「查看原查询」链接可见。
  - **390px**：侧边栏收起后主内容宽 390px；筛选纵向排列、卡片列表可读，卡片「观察与版本」按钮为 44px 高；详情弹窗宽 358px、内部纵向滚动，观察表（含对应决定列与原行操作）在弹窗内横向滚动，右上关闭可用；桌面同理。
  - 记录为人工操作观察，不是像素级断言；桌面/移动均未发现横向整页溢出。

## 存储与历史投影

存储、迁移、规则版本与回填路径见 [平台业务记录契约](platform-business-record-contract.md) 的「business_list 来源专用 typed 投影（#457）」。历史观察继续通过 `platformRecordObservations`（每批 1..100）投影；预检/提交回执给出 `businessProjectionsCreated`/`businessProjectionsReused`。本层不新增写入命令。
