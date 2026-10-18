# 已认定企业列表证据的显式转存（#59）

实时 `source=queryBusList` 唯一映射为持久化 `interface=recognized_list`（已认定企业列表）。`businessList → business_list`、`queryList → apply_list` 不变；不重分类历史行。查询及批量任务仍只读，不隐式保存业务证据。

## 转存协议

先发现当前 OpenAPI/MCP tools/list。REST 使用已鉴权的 `POST /api/roster/import/preflight`、`POST /api/roster/import/commit`，请求与旧客户端兼容。来源封套用 `sourceKind:"alias_evidence"`、真实归档逻辑身份 `sourceIdentity` 和稳定 `idempotencyKey`；这不代表创建别名。MCP 使用 `preflight_roster_batch`、已鉴权的 `save_roster_batch`；旧 MCP 只读预检策略不变，预检不写业务数据。所有实际写入均为鉴权、原子事务。

TypeScript 调用方可复用纯函数：

```ts
import { recognizedResultToImport } from '../lib/platform/recognized-evidence'
const payload = { platformQueries: [recognizedResultToImport(originalResult)] }
// 同一封套和幂等键：preflight -> commit -> 公开读回。
```

批量结果逐项取 `GET /api/platform/batches/{batchId}/items/{itemId}` / `get_platform_batch_item`，保留所有 `segments`，每段分别调用 `recognizedResultToImport(segment)`。不把历史失败段和补查段压成一次新查询，不重新抓取，不改原时间。可在一个统一批次中提交多段；同批同查询自然键重复需先消除重复项，但不同查询时点和同码多行必须全部保留。该函数只构造载荷，不发网络请求、不提交、不确认主体。

每个 `platformQueries[]` 新来源项：

- `interface:"recognized_list"`，`queryKey` 等于原条件中的 `uscc`，没有代码时为 `name:<原查询名>`；名称查询命中只是候选。
- `rdjb` 是原 `titleScope.rdjb` 按原顺序用逗号连接，例如 `"1,2,3"` 或 `"3"`；单称号 `titleCode` 必须对应其称号，多称号留 null。1 创新型、2 专精特新中小企业、3 小巨人。
- `queriedAt` 必须与原结果一致，`collectionEvidence` 必填，保存完整原 `PlatformLiveQueryResult`：`source`、实际条件、称号范围、原查询和完成时间、页状态/计数/末页、可靠总数或 null、完整性、fullRange、unfinished、原始行及限制。
- `relations` 与 `collectionEvidence.rows` 按顺序一一对应，`sequenceNo` 从 1 连续编号；`relationKey`/`usccRaw`/`nameRaw` 分别取原行 `id`/`tyshxydm`/`qymc`，没有就 null；`rawFields` 原样保留。相同平台 id 或代码出现多次仍逐条落库。
- 不把 `whpcyear`/`whpc`、认定日期、有效年份/日期、平台属地塞进旧接口含义不同的年份/批次列。新来源原字段从 `rawFields` 读取（旧含义的标准化字段若非空则拒绝）；软件不生成称号事件、快照、别名或差异结论，不更新企业名称或属地。

有可靠代码时关系只按现有企业的精确代码匹配；无法匹配留空待核。显式 `enterpriseId` 必须对应原行代码，不能凭名称确认主体。独立身份归并、曾用名确认仍走原有证据工作流，新来源不扩展其自动权限。

## 完整性与归档限制

`status` 扩为 `success | no_record | partial | failed | not_queried`。原始 `auth_failed` 在未取得行时保存为 failed，原状态/error 仍在 collectionEvidence；取得部分行后保存 partial。续页结果 `fullRange:false` 即使所请求范围完成也只登记 partial，不能代表从头穷尽。

完整状态要求所有请求称号的页连续、无失败和 unfinished，行数与页数对账，并有每称号终止证明：可靠总数全部覆盖、原响应 `maxPage` 到达末页，或有效零行尾页。实时结果新增可空 `pages[].maxPage`，旧结果缺该字段仍可读取；旧归档若总数未知且非空尾页又无末页证明，明确报 `collection_evidence_invalid`，不能补造末页或时点。单称号零条仅证明该称号和实际筛选条件，不能冒充三称号全范围无记录。HTTP 200 登录页在查询层为 auth_failed，不能转成成功空结果。

partial/失败/未查询必须保留每个未完成称号的实际 next/failed page，查询时点和完成时点必须有效且有序。缺来源、条件、时间、页行对应或状态自相矛盾，预检给出明确错误且提交不写业务数据。归档不能证明的事实保持待补，不通过当前时间或更换来源绕过。

自然键仍为 `(interface,queryKey,rdjb,queriedAt)`，关系键为 `(queryId,sequenceNo)`。相同原始证据可幂等重放；同键不同原始采集内容报 `collection_evidence_conflict`，不能覆盖历史。未知提交结果用原幂等键恢复，不能换键重写。

## 公开读取和显式决定

`GET /api/platform/queries` 与 MCP `list_platform_queries` 支持 `interface`、`queryKey`、`uscc`、`enterpriseId`、`titleCode`、`status`、`page`、`pageSize`、`includeRawResponse`。返回 `rows[{query,relations}]`、total、分页和状态 counts；计数在分页前计算，每个查询仍返回全部关系。`enterpriseId` 的历史过滤语义沿用旧接口：匹配关系归属；无行查询可用 queryKey/uscc 查询。企业详情同时按企业查询键补出零记录/失败证据。

`query.collectionEvidence` 旧记录为 null；关系新增可空 `sourceRdjb`、`sourcePage`，由原页行计数映射。`GET /api/roster/enterprises/:id` / `get_enterprise_detail` 的 `platform.queries` 同样带 collectionEvidence/titleCode，`platform.relations` 带 rawFields 和页/称号。#60 应展示实际条件、原时间、历史与状态，按 sourceRdjb 显示各称号原字段，不把维护年当认定年。

企业详情与对比页对纳入的已认定查询读取全部原始来源行，包括先归档、后建主档时仍未匹配的行。新来源行额外返回 `enterpriseId: number | null`（旧来源可不带该字段）；null 明确表示未匹配主体，查询键覆盖不代表主体确认。读取不重匹配、不回填归属。查询的 `relationCount` 与实际返回行一致，对比页 `platform.relationCount` 为所展示查询的来源行总数；不纳入查询键和已有关系归属均无关的其他查询。

显式差异决定引用已认定查询或行时，非空 supplied USCC 必须与解析到的企业代码一致；名称回退不能覆盖矛盾代码。查询/行 ID 与自然键引用适用同一校验；未提供代码时保留既有有效名称定位行为，证据仍必须满足精确主体与称号约束。

`differences[].evidenceQueryRef/evidenceRelationRef` 可用新来源同批自然键；裸查询/关系 ID 也可引用已存行。省略 queriedAt 仍要求唯一；错误来源、跨查询混指、其他企业/称号的关系拒绝。query-only 引用需查询键精确指向目标代码。显式差异决定仍由代理给出，软件不自动判断原因。

## 验收边界

`tests/platform-recognized-evidence.test.ts` 使用公开 HTTP 写入/历史读取、MCP 注册工具、真实临时 SQLite 和合成分页响应/凭据，覆盖三称号、同码多行、跨来源同 ID、原时间、零/partial/登录失败/未查询、缺元数据、来源/身份/称号冲突、幂等及存储故障回滚、自然键决定引用。旧双接口回归另跑既有测试。该证据不等于实平台账号验收、真实归档补录、生产数据库执行或 #60 界面验收；本票没有执行这些操作。
