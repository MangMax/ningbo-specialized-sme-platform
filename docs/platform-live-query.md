# 平台实时只读查询（#51，共享契约 v1）

`POST /api/platform/query` 与 MCP `query_platform` 使用同一服务。入口不要求本库存在企业，不创建企业、别名、事件、证据、任务或快照。历史读取 `GET /api/platform/queries` 与 reconcile 保持原有接口和语义。

能力发现：`GET /api/platform/capabilities` / MCP `get_platform_capabilities`；开发环境 OpenAPI `/_openapi.json`，生产默认继续关闭。沿用应用只读入口无 token、写入/任务另行鉴权的既有策略。持有服务端平台会话不会取得应用写入权限。

## 来源与参数

本次仅启用 `source: "queryList"`（申报记录，原适配来源 `apply_list`）。`businessList`（关联记录）和 `queryBusList`（已认定企业列表）有独立来源身份，当前明确拒绝，后续 #52/#53 接入。能力表中的未启用来源信息不是已验证能力承诺。

`name` 是平台 `qymc` 关键词（全称也可），`uscc` 是 `tyshxydm`（18位大写字母/数字）；至少一个必填。同时提供时两个字段同时传给平台，按 AND 组合；名称结果仅为候选，不能据此自动确认身份。未添加日期、区域或称号过滤。当前不接受 `rdjb`、日期、区域、排序或其他未知字段，REST 和原始 MCP RPC 均明确拒绝，不能静默忽略。不接受 Cookie、凭据或账号参数，不能先调用 reveal。

| 参数 | 默认 | 允许范围 |
| --- | --- | --- |
| pageSize | 50 | 1–50 |
| startPage | 1 | 1–100000 |
| maxRequests | 100 | 1–100 |
| maxRows | 5000 | 1–5000 |
| maxDurationMs | 60000 | 1–60000 |

实际每页大小为 `min(pageSize,maxRows)`，见结果 `limits.pageSize`。本次单项入口不自动重试；失败直接给未完成页，认证失效不重试。每请求超时最多15秒，受操作剩余时间进一步限制；总时间包含全局预算排队等待。进程内所有平台消费者（包括旧 reconcile）共享最多2个请求槽位；响应正文读取和旧客户端退避期间也占用槽位。多进程部署需要外部共享限流器，本实现按现有单进程 Nitro 运行边界提供预算。

## 结果与完整性

共享类型、输入/输出 schema 在 `lib/platform/live-query.ts`，服务在 `server/utils/platform-live-query.ts`；静态 OpenAPI schema 在 `server/api/platform/query.post.ts`。后续来源沿用结果和页位置类型，不能把关系按代码去重。

- `source`：实际平台来源；`effectiveConditions`：实际条件和 `combination:"and"`。
- `titleScope`：当前为 `{mode:"source_default",rdjb:[]}`，表示未施加称号过滤，不表示逐称号已查证。
- `queriedAt` / `completedAt`：本次开始/完成时间（ISO）；无缓存。
- `rows`：全部逐条原字段（沿用适配器的标量字符串化），不压缩同码多关系/曾用名，不返回原始页面或无关账号信封。
- `pages`：逐页来源、rdjb（当前null）、page、status、fetchedCount、declaredTotal、error。
- `declaredTotal`：可靠的上游声明数量；缺失/无法可靠解释时为null，不能用0代替未知。
- `fetchedCount`：返回记录数；`completeness` 为 complete / partial / not_queried；`fullRange` 为是否从第一页开始。
- `unfinished`：可继续的 `{source,rdjb,page}` 位置。续查保留相同条件和结果中 `limits.pageSize`，设 `startPage`；各次结果按页保留，不按USCC去重。续查完成仅表示所请求的剩余范围完成，`fullRange:false` 不能声称从头穷尽。
- `error`：固定code与安全文案，不包含上游原文、Cookie、异常原文或凭据存储细节；成功为null。

| status | 含义 |
| --- | --- |
| success | 请求范围完整且非空 |
| no_record | 请求范围完整且有效零条，仍需检查fullRange及条件 |
| auth_failed | 第一页认证失效（包括HTTP200登录页） |
| failed | 第一页上游、限流、超时或响应错误 |
| partial | 已完成部分页后失败，或安全上限中断；unfinished定位未完成页 |
| not_queried | 凭据不可用，未请求平台，绝非零条 |

错误code包括 `invalid_input`、`unsupported_source`、`credential_unavailable`、`auth_failed`、`upstream_failed`、`timeout`、`rate_limited`、`safety_limit`、`invalid_response`、`sensitive_response`。REST非法输入为HTTP400 `{error:{code,message}}`；MCP原始RPC非法输入为HTTP400 / JSON-RPC -32602。有效查询中的业务失败/partial保留统一结果（REST HTTP200）。只有成功完成且零条才返回no_record。未知总数继续请求至结构有效的空页；空页与已声明总数矛盾、页号不一致或总数变化时不能声称完整。

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

新增来源必须复用 `postPlatformRequest`（`lib/platform/client.ts`）或 `withPlatformRequestBudget`，不能绕开全局预算，也不要在已持有槽位时再次获取槽位。能力表仅启用已实现且验证的参数。#52需要逐称号位置，#53不能按名称猜测筛选语义；#54需独立定义批次总量/体量及重启策略。

## 验证边界

`tests/platform-live-query.test.ts` 经实际REST handler与MCP handler覆盖分页、关系保留、失败、续查、严格参数、合成凭据安全、SQLite不变、快照及共享限流，并包含真实本地HTTP调用。上游为受控脱敏样本；没有使用真实Cookie、调用实平台或写入业务数据。公开能力的上游名称搜索/组合过滤语义仍应由维护者在受控账号下补充实平台验收，本次不能把模拟验收提升为实平台证据。
