# 平台实时只读查询（#51/#53，共享契约 v1）

`POST /api/platform/query` 与 MCP `query_platform` 使用同一服务。入口不要求本库存在企业，不创建企业、别名、事件、证据、任务或快照。历史读取 `GET /api/platform/queries` 与 reconcile 保持原有接口和语义。

能力发现：`GET /api/platform/capabilities` / MCP `get_platform_capabilities`；开发环境 OpenAPI `/_openapi.json`，生产默认继续关闭。沿用应用只读入口无 token、写入/任务另行鉴权的既有策略。持有服务端平台会话不会取得应用写入权限。

## 来源与参数

启用 `source: "queryList"`（申报记录，原适配来源 `apply_list`）及 `source: "queryBusList"`（已认定企业列表）。`queryBusList` 请求 `ZjtxxjrBusInfoManageBLH/queryBusList`，解析 `businessGrid`；即使响应 Content-Type 是 text/html，也按正文解析 JSON。它不是 `businessList` / `business_list` 或 `apply_list` 的别名。`businessList`（关联记录）由 #52 独立接入，本分支未启用。

`name` 是平台 `qymc` 关键词（全称也可），`uscc` 是 `tyshxydm`（18位大写字母/数字）；至少一个必填。同时提供时两个字段同时传给平台，按 AND 组合；名称结果仅为候选，不能据此自动确认身份。`queryList` 不接受 `rdjb`、日期、区域、排序。`queryBusList` 的额外条件见下表，默认清空非必需限制。未知字段或不属于来源的条件，REST 和原始 MCP RPC 均明确拒绝，不能静默忽略。不接受 Cookie、凭据或账号参数，不能先调用 reveal。

| 参数 | 默认 | 允许范围 |
| --- | --- | --- |
| pageSize | 50 | 1–50 |
| startPage | 1 | 1–100000 |
| maxRequests | 100 | 1–100 |
| maxRows | 5000 | 1–5000 |
| maxDurationMs | 60000 | 1–60000 |

实际每页大小为 `min(pageSize,maxRows)`，见结果 `limits.pageSize`。本次单项入口不自动重试；失败直接给未完成页，认证失效不重试。每请求超时最多15秒，受操作剩余时间进一步限制；总时间包含全局预算排队等待。进程内所有平台消费者（包括旧 reconcile）共享最多2个请求槽位；响应正文读取和旧客户端退避期间也占用槽位。多进程部署需要外部共享限流器，本实现按现有单进程 Nitro 运行边界提供预算。


### queryBusList 已验证筛选

| 参数 | 语义与限制 |
| --- | --- |
| rdjb | `['1']` 创新型中小企业 / `['2']` 专精特新中小企业 / `['3']` 小巨人；可组合，非空且不重复；缺省依次查全三称号 |
| sqsj | 认定时间范围，格式严格为 `YYYY/MM/DD - YYYY/MM/DD`，真实日历日期且起始不晚于结束；不承诺端点包含规则或平台时区 |
| rddqrq | 四位有效年份（例如 `2027`），不是精确到期日期；不推测平台当前年份选项的永久上下界 |
| whpcyear | 四位维护年份（例如 `2023`），可能与 rdtime 的年份不同；返回行该字段可能为空 |
| whpc | 维护批次字符串 `1`–`15`，必须与 whpcyear 同时提交；拒绝独立批次，实测平台会忽略独立批次；不是 `YYYY-N` |
| szq | 账号可见范围内的8位筛选码；必须由该账号页面取得；这里只校验8位格式，不能证明代码属于当前会话选项。没有全局区域字典，不根据结果行转换 |
| orderField / orderDirection | 必须一起给出，仅支持 `qymc` 与 `asc`/`desc`；其他字段未功能实证，明确拒绝 |

所有主动条件回显在 `effectiveConditions`，所选称号回显在 `titleScope` 与逐页位置；不把维护年/批次转成公告认定事件。即使不带筛选，结果仍限于服务端会话账号的可见范围，不能声称全国全局穷尽。实测账号中余姚筛选码为 `33028100`，返回行 `szq` 却是 `133028100`；不能将行值直接用于筛选，也不应据此推导通用转换规律。

```json
{"source":"queryBusList","name":"合成","rdjb":["1","2","3"],"sqsj":"2024/02/01 - 2024/02/29","rddqrq":"2027","whpcyear":"2023","whpc":"2","szq":"33028100","orderField":"qymc","orderDirection":"desc"}
```

queryBusList **不使用 nextPage**：实测中间页仍返回1。按请求页号递增，核对响应 page、pageSize、maxPage 和可靠 maxCount；短中间页、页号/总数/最大页变化或矛盾均不报告完整。缺失可靠 total 时明确返回null，可使用一致的 maxPage 结束；两者均未知时取至有效空页，仍受全局请求/行数/时间上限约束。已认定来源要求响应 page/pageSize 与请求一致，不能在分页形态无法确认时声称查全。多称号是依次分页，不提供跨称号全局排序或原子快照保证。

## 结果与完整性

共享类型、输入/输出 schema 在 `lib/platform/live-query.ts`，服务在 `server/utils/platform-live-query.ts`；静态 OpenAPI schema 在 `server/api/platform/query.post.ts`。后续来源沿用结果和页位置类型，不能把关系按代码去重。

- `source`：实际平台来源；`effectiveConditions`：实际条件和 `combination:"and"`。
- `titleScope`：queryBusList 为 `{mode:"selected",rdjb:["1","2","3"]}`（或调用者所选），逐称号查询；queryList 为 `{mode:"source_default",rdjb:[]}`，表示未施加称号过滤，不表示逐称号已查证。
- `queriedAt` / `completedAt`：本次开始/完成时间（ISO）；无缓存。
- `rows`：全部逐条原字段（沿用适配器的标量字符串化），不压缩同码多关系/曾用名，不返回原始页面或无关账号信封。
- `pages`：逐页来源、rdjb（queryList为null，queryBusList为实际称号码）、page、status、fetchedCount、declaredTotal、error。
- `declaredTotal`：可靠的上游声明数量；queryBusList 按称号求和（不是去重企业数），任何选定称号尚未取得可靠总数时为null；缺失/无法可靠解释时为null，不能用0代替未知。
- `fetchedCount`：返回记录数；`completeness` 为 complete / partial / not_queried；`fullRange` 为是否从第一页开始。
- `unfinished`：可继续的 `{source,rdjb,page}` 位置。续查保留相同条件和结果中 `limits.pageSize`，设 `startPage`；queryBusList 应逐个 unfinished 位置设置单称号 `rdjb:[该位置rdjb]`，不要把某称号的续页应用于全部称号；各次结果按页保留，不按USCC去重。续查完成仅表示所请求的剩余范围完成，`fullRange:false` 不能声称从头穷尽。
- `error`：固定code与安全文案，不包含上游原文、Cookie、异常原文或凭据存储细节；成功为null。

| status | 含义 |
| --- | --- |
| success | 请求范围完整且非空 |
| no_record | 请求范围完整且有效零条，仍需检查fullRange及条件 |
| auth_failed | 第一页认证失效（包括HTTP200登录页） |
| failed | 第一页上游、限流、超时或响应错误 |
| partial | 已完成部分页后失败，或安全上限中断；unfinished定位未完成页 |
| not_queried | 凭据不可用，未请求平台，绝非零条 |

错误code包括 `invalid_input`、`unsupported_source`、`credential_unavailable`、`auth_failed`、`upstream_failed`、`timeout`、`rate_limited`、`safety_limit`、`invalid_response`、`sensitive_response`。REST非法输入为HTTP400 `{error:{code,message}}`；MCP原始RPC非法输入为HTTP400 / JSON-RPC -32602。有效查询中的业务失败/partial保留统一结果（REST HTTP200）。只有所有选定称号及请求页成功完成且零条才返回no_record。queryBusList 失败后停止，unfinished 同时包含当前失败页与其余未查称号的起始页。未知总数继续请求至结构有效的空页；空页与已声明总数矛盾、页号不一致或总数变化时不能声称完整。

达到行数上限时保留已完成整页，不截断单页。若下一页无法整页纳入，则该页不进入rows，unfinished仍指该页；调用者可提高上限后补查。请求/时间上限同样返回partial及位置。

## 无凭据调用示例

```sh
curl -sS http://localhost:3000/api/platform/capabilities
curl -sS http://localhost:3000/api/platform/query \
  -H 'Content-Type: application/json' \
  -d '{"source":"queryList","name":"合成","maxRequests":10}'
```

MCP业务参数（由客户端包装tools/call）：

```json
{"name":"query_platform","arguments":{"source":"queryList","uscc":"91330211255994457P","maxRequests":10}}
```

第二页失败/上限后补查：

```json
{"name":"query_platform","arguments":{"source":"queryList","name":"合成","startPage":2,"pageSize":50}}
```

只有完整收到所有要求的页、确认条件和称号范围后，才评估证据是否穷尽。平台当前申报事实不能替代公布文件的历史认定事件；身份确认和预检/写入仍走独立流程。

## 凭据与后续接入

凭据使用现有 `resolvePlatformCookie`（保存值优先、否则环境）；服务仅在操作开始解析一次，固定在内存中。#54 批次可通过 `PlatformLiveQueryContext.cookie` 提供提交时内存快照，严禁把context序列化到任务参数。没有新增持久化结果/缓存/数据库表。敏感业务字段或凭据回显会阻止该页返回，原始信封不输出。查询响应设no-store。

新增来源必须复用 `postPlatformRequest`（`lib/platform/client.ts`）或 `withPlatformRequestBudget`，不能绕开全局预算，也不要在已持有槽位时再次获取槽位。能力表仅启用已实现且验证的参数。#52需要逐称号位置，#53按实测开放已验证筛选；#54需独立定义批次总量/体量及重启策略。

## 验证边界

`tests/platform-recognized-query.test.ts` 补充已认定来源的三页/三称号、全部筛选与原始RPC严格校验、独立来源和原字段、失败/上限/单称号续查、能力/OpenAPI及REST/MCP对等。`tests/platform-live-query.test.ts` 经实际REST handler与MCP handler覆盖分页、关系保留、失败、续查、严格参数、合成凭据安全、SQLite不变、快照及共享限流，并包含真实本地HTTP调用。上游为受控脱敏样本；没有使用真实Cookie、调用实平台或写入业务数据。queryBusList 的上游能力依据维护者提供的 2026-10-18 浏览器实测：三个称号、名称/代码、日期范围、年份、维护年+批次、账号区域码、qymc双向排序，以及20/20/10的完整三页（total50）。实测没有验证日期边界是否包含、平台时区、全局区域字典或其他排序字段。本实现的 REST/MCP 验收使用合成/脱敏样本，不能把上游浏览器观察当作应用入口的实平台验收。queryList 的上游组合语义仍需维护者受控验收。
