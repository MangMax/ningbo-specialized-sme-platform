# 无需读取平台凭据的操作示例

`platform-scenarios.json` 提供单条查询、混合来源批量、会话过期、第二页失败、同代码多关系的合成输入。`investigate-platform.mjs` 只通过应用执行。批量提交/重试需要应用 API 任务令牌，与平台凭据无关。

```js
import { querySingle, investigatePlatform, retryUnfinishedBatch } from './investigate-platform.mjs'
const single = await querySingle({ baseUrl, query: scenarios.single })
const batch = await investigatePlatform({ baseUrl, apiToken, queries: scenarios.batch })
// 先检查每项的状态、分段、分页范围和未完成位置。
// 服务端会话维护完成或临时故障恢复后：
const recovered = await retryUnfinishedBatch({ baseUrl, apiToken, batch })
```

各情形的预期处理：

- `single`：保留候选、全部原始行、分页范围及时间。
- `batch`：每个回执 itemId 对应唯一企业调查者，保留三个来源身份及其不同称号参数约定。
- `expired`：返回 `auth_failed`，若前页已成功也可能为部分完成；保留全部未完成范围，请运维在服务端维护凭据。不自动反复鉴权，不认定为零记录。
- `secondPageFailure`：保留第一页行和原 `queriedAt`/`completedAt`，明确批量重试只查第二页以后。`queued`/`running`/`poll_limit` 不等于批次完成。
- `multipleRelations`：同一代码可有多行、多称号；分段内每条关系都保留，不按代码折叠或推断身份。

无需真实账号的合成传输验证：

```sh
pnpm test:runtime tests/platform/transport/agent-workflow.test.ts
```

测试只调用应用接口，使用合成上游响应和隔离 PostgreSQL。候选证据的核查与预检、提交分别执行。

证据转存是单独授权步骤。queryBusList 的每个原始结果或批量 `segments[]` 应用 `layers/sme-roster/lib/platform/recognized-evidence.ts` 的 `recognizedResultToImport` 转换，再用同一幂等键统一预检/提交，并通过 REST 历史或 `list_platform_queries` 读回全部查询/行 ID。不能重放实时查询来填补归档缺失的原时间或末页证明，见[转存契约](../../../../layers/sme-roster/lib/platform/recognized-evidence.ts)。

主体事实例子在 [enterprise-facts.mjs](enterprise-facts.mjs)，载荷与完成条件见[公开协议](../references/enterprise-facts.md)。调用者提供已初始化 SDK 客户端的 `call(name,args)`，它必须检查 `isError` 并解码 JSON，不能把 MCP 错误文本当正常返回。分别调用 `prepareFactCommand` → 持久保存 prepared → `commitPreparedFact`，每次确认/更正/撤回都是新的明确动作；`confirmedFactReferences` 选择多个当前确认版本，`saveReferencedDecision` 精确读回保存版本。函数不读取 Cookie，不启动任务，不自动重试或确认。

公布名单用 [announcement-intake.mjs](announcement-intake.mjs) 预检并留存原行。取得 `intakeId` 和 `sourceDigest` 后，另行提供逐行已核对的身份与依据再调用补充。用当前 OpenAPI 核对鉴权和请求字段。
