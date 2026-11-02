# 申报记录本地查询（#453）

本层消费 #452 的 `platform_apply_projection`，提供只读的本地申报记录 HTTP/MCP 查询与最小页面。只覆盖 `apply_list`（上游 `queryList`）；不迁移 `business_list`/`recognized_list`，不访问外部平台，不写业务数据。

## 查询入口

| 入口 | 契约 |
|---|---|
| `GET /api/platform/declarations` | 等价 MCP `list_platform_declarations`。 |
| `GET /api/platform/declarations/{recordId}` | 等价 MCP `get_platform_declaration`。 |
| 页面 `/platform-declarations` | 侧边栏「申报记录」入口；筛选、分页、观察与版本详情。 |

公共筛选：`view=records|isolated`（默认 records）、`q`（企业名称/统一社会信用代码关键词，只通过已归属观察匹配）、`enterpriseId`、`platformKey`（精确申报编号）、`declareKind`（原 `sblx`）、`year`（来源明确年份）、`status`（原 `cszt`）、`page`、`pageSize`（最多 200）。

- `records` 按业务记录组织：同一 `platform_business_record` 的匹配内容版本压缩为一行，返回匹配版本、匹配版本数、全部版本数、观察数、最近采集时间、企业归属与冲突。匹配版本按 `applied_at` 最新（缺失最后）再按 `version_id` 选择；不代表正式结论或时间顺序。
- `isolated` 单独列出 `missing_key`、`conflict`、`unverifiable` 或无版本的申报观察，不并入任何记录；仍按原 `relationId` 可定位。
- 未知 `sblx`/`year`/`cszt` 保持 null/原值；不从 `sqsj`、`queriedAt`、`batch` 推年份，不推称号，不跨接口合并。

## 详情边界

详情返回记录身份、全部内容版本（最多 100）和实际观察元数据（最多 200），包括版本 typed 字段、版本哈希、观察的 relation/query/采集时间/企业归属/identity/content 状态及版本引用。超出上限时 `counts.versionsTruncated`/`observationsTruncated=true`，不静默截断。**不返回 raw JSON、不返回对应决定内容**；原档仍走 `/api/platform/queries/{queryId}/evidence`。

## 预算

- 列表只查 `platform_apply_projection` 与既有索引列；企业关键词通过已归属 observation/relation/enterprise 做 `EXISTS`，不扫描 raw。
- 每页最多 200 个业务记录；详情最多 100 个版本和 200 次观察；计数另查。
- 稳定排序：记录按最近采集时间倒序、ID 倒序；版本按版本 ID 倒序；观察按采集时间倒序、relation ID 倒序。
- 失败返回 400/404；不会把失败或无记录混成空结果。

## 存储与历史投影

存储、迁移、规则版本与回填路径见 [平台业务记录契约](platform-business-record-contract.md) 的「apply_list 来源专用 typed 投影」。历史观察继续通过 `platformRecordObservations`（每批 1..100）投影；预检/提交回执给出 `applyProjectionsCreated`/`applyProjectionsReused`。本层不新增写入命令。

## 验收边界

- 真实隔离 SQLite + 公开 REST/MCP handler：筛选、分页、未知值、缺编号隔离、历史版本、无 raw 泄露、非法输入。
- 页面组件覆盖记录表/隔离表/详情；实际桌面与 390px 操作在集成分支构建后执行，不以像素断言代替。
- 不操作生产数据库/WAL/原始文件；不部署、不合并 main。
