# 查询覆盖、当前决定与解释有效性（#108 / #109）

2026-10-19。增量公开读契约，供 #110 复核服务与 #111 页面消费。旧 `status`、
`explanationId`、原因、措施及证据字段保持原义，不把查询结果自动写成业务决定。

## 公开位置

`GET /api/roster/differences`、MCP `list_differences` 的行和企业详情
`GET /api/roster/enterprises/:id` / `get_enterprise_detail` 的 `differences` 行新增：

- `queryCoverage`：`{ status, sources, truncated }`。
- `currentDecision`：直接复用 #102 `currentDecision102` 的
  `{ enterpriseId, titleCode, direction, versionId, current }`。`current` 保留稳定 ID、
  原因、措施、来源及 `evidenceQueryId` / `evidenceRelationId`；撤回后
  `versionId` 是撤回版本 ID，`current=null`，不得恢复前一个决定。
- `explanationValidity`：`{ status, reasons, explanationId, evidenceQueryIds }`。
- `assessment`：`not_queried | queried_unjudged | decided | withdrawn | unknown`。

企业详情另增 `titleAssessments`：三个受支持称号 × 两方向的上述对象。它独立于当前差异集合，
使两边记录一致、没有差异行时也能读取覆盖与决定。没有当前决定且覆盖完整是
`queried_unjudged`（尚未判断）；没有执行过的查询才是 `not_queried`（未查询）。

## 覆盖范围

`queryCoverage.status` 是 `not_queried | complete | partial | failed | unknown`。
每个 `sources` 项给出 `queryId, interface, queriedAt, queryStatus, status, titleCode, rdjb,
conditions, pages, fullRange, completeness, unfinished, outcome, subjectMatch`。
`queryStatus` 保留采集行的旧状态，`status` 是该次请求范围的覆盖状态；`outcome` 仅在完整且主体确定时可为
`records | no_record`，否则 `unknown`。`subjectMatch` 是 `exact_uscc | matched_relation |
name_only | unknown`。保留分页和过滤条件，不能把局部成功提升为全称号无记录。

每坐标最多读取最新 50 次相关查询（按 queriedAt DESC,id DESC），多出时
`truncated=true`，整体不能声称完整。仅 SQL 投影采集元数据，不读取 `raw_response`
或 `collection_evidence.rows`。SQLite 仍需解析选中的 JSON 文本；此处不声称常数 IO。

覆盖按企业、接口、称号和实际条件区分。queryList 不提供称号选择，不能证明任何单称号
完整；其他称号不会抵消本称号未完成。没有分页元数据的旧 success/no_record 仅为
`unknown`，HTTP 200、失败、登录页、partial 都不是零记录。完整且 fullRange=true、
按该企业统代、无额外条件、称号明确的 businessList / queryBusList 才能证明本称号
的整体覆盖（至少一个接口完整，其他接口状态仍分别保留）。name-only 为平台关键词查询；未匹配行不确认主体、不证明企业无记录。
不拼接不同条件或不同时点的分页，不自动重匹配未归属行。查询条件命中企业不等于原行已归属；
返回行尚无该企业归属时，即使查询范围完整，非零结果的 `outcome` 仍为 `unknown`。
同接口、同条件和同 fullRange 的最新重试覆盖旧尝试的汇总状态；每次原始尝试仍在 sources 中。

## 有效性与后续复核

`explanationValidity.status` 是 `not_applicable | premise_invalid | unknown`。
`reasons` 为稳定机器码数组：旧 not_queried 遇同称号实际执行查询时
`query_executed`；缺少可核验的决定证据基线时 `no_evidence_baseline`。
`premise_invalid` 只否定“未查询”前提，既不猜新原因，也不撤回或替代决定。
其余已有决定暂为 `unknown`，不能把未发现变化说成有效；#110 用明确证据基线扩展
`valid | evidence_changed` 及原因。覆盖变化不等于实质事实变化，重复证据不产生任务。
方向和已关联事件的影响检查属于 #110；本读模型不创建任务、规则版本或发布范围。

## 权限、缓存与依赖

沿用公开只读无需 token；所有上述 REST/MCP 响应 `Cache-Control: no-store`。
复用同一领域读函数和请求内 SQLite 读快照，不添加结果缓存或决定写面。
#102 经集成提交 `5d530cc` 进入本票分支；当前决定直接调用实际 #102 服务，
包括撤回语义。没有复制生命周期服务或迁移，不用旧 JSON 人工标注冒充正式决定。
REST 差异保留“当前对比坐标 ∪ 已有解释”，MCP 差异保留原有“已存解释”集合及计数，
两种列表的新增对象与企业详情同源。全局计数只读窄坐标元数据，说明与证据按结果页水合。
本票无持久证据基线；#113 / #114 在本契约基础上提供证据绑定和复核完成。

不写生产数据、不迁移旧决定、不自动判因；生产积压处理另行授权。
