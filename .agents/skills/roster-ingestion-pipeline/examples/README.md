# 无需读取平台凭据的操作示例

`platform-scenarios.json` 提供单条查询、混合来源批量、会话过期、第二页失败、同代码多关系的合成输入。`investigate-platform.mjs` 只通过应用执行。批量提交/重试需要应用 API 任务令牌，与平台凭据无关。

```js
import { querySingle, investigatePlatform, collectBatch, retryUnfinishedBatch } from './investigate-platform.mjs'
const single = await querySingle({ baseUrl, query: scenarios.single })
const batch = await investigatePlatform({ baseUrl, apiToken, queries: scenarios.batch })
// 每次调用前在外部持久保存完整 batch（含 checkpoint、回执和历史观察）。
// poll_limit / queued / running 先续读同一批，仅 GET：
const observed = await collectBatch({ baseUrl, batchId: batch.batchId, checkpoint: batch.checkpoint })
// 保存 observed；核实终态、真实 items、全部 segments/时间与 unfinished。
// 服务端维护完成，调用者另一次明确授权后，才补查所选未完成项：
const recovered = await retryUnfinishedBatch({ baseUrl, apiToken, batch: observed, itemIds: selectedUnfinishedIds })
```

`poll_limit` 是本地观察上限，不是服务端状态；任务可能仍 queued/running 或已终结。截止结果的 `serverState` 与 `checkpoint.receipt` / `checkpoint.lastBatch` 分别保留已知状态、原回执和最后成功 GET 原对象；没有 GET 时不推测进度、attempt 或时间。没有取得项时 `items:[]` 表示未知，不能宣布已完成、无未完成项或无记录。

`collectBatch` 继续 GET 同一批，不提交、不补查；收到 poll_limit/queued/running 的 `retryUnfinishedBatch` 也只续读，即使读到 terminal partial，本次仍不 POST，返回供调用者审查。只有另一次明确调用、终态 done/failed/cancelled 且真实 items 可用时，retry 才提交所选未完成项（省略 itemIds 表示全部未完成项）。新 retry 回执保存在 checkpoint.receipt，当前 lastBatch 从 null 开始，旧完整观察单列 previousBatch；新 queued 回执不被旧终态覆盖。恢复观察不代表恢复执行。

HTTP/JSON 首次错误原样抛出，不自动重新 submit/retry；调用前外部保存检查点，以便错误后继续追溯。保留全部原时间、分段、历史失败和同 USCC 的不同关系，不重新采集补造旧证据。

本文件现有 scenarios 是兼容流程样例，未请求 `rawDataVersion:1`；`rows` 是兼容字符串投影，不证明原 JSON 类型或接受页原文保真。需要 v1 原档时，在明确的新查询输入中选择 `rawDataVersion:1`，检查每个结果或批量 `segments[]` 的 `rawData.version`、`rawData.rows`、`rawData.pages`，并按下文的[转存契约](../../../../docs/platform-recognized-evidence.md)处理。旧结果缺少 `rawData` 时原始类型未知，不重新采集补造旧时间，不修改旧 hash 或历史证据。

各情形的预期处理：

- `single`：保留候选、全部兼容字符串投影行、分页范围及时间。
- `batch`：每个回执 itemId 对应唯一企业调查者，保留三个来源身份及其不同称号参数约定。
- `expired`：返回 `auth_failed`，若前页已成功也可能为部分完成；保留全部未完成范围，请运维在服务端维护凭据。不自动反复鉴权，不认定为零记录。
- `secondPageFailure`：保留第一页行和原 `queriedAt`/`completedAt`，明确批量重试只查第二页以后。`queued`/`running`/`poll_limit` 不等于批次完成。
- `multipleRelations`：同一代码可有多行、多称号；分段内每条关系都保留，不按代码折叠或推断身份。

无需真实账号或读取 Cookie 的复现命令：

```sh
MIIT_COOKIE='' MIIT_COOKIE_FILE='' pnpm test tests/platform-agent-workflow.test.ts
```

`platform-agent-workflow` 测试以 `node:http` 手工路由暴露合成应用 HTTP 夹具，使用临时 SQLite 与服务端合成凭据，调用共享查询与批次核心，执行示例导出函数、注入登录/第二页失败并核对应用 REST 路径。它不启动 Nitro，不执行 MCP 传输，只证明合成上游样例的流程，不代表真实平台或生产验收；代理不读或展示平台凭据，不直调平台。主体事实的真实 `/mcp` SDK 传输验证使用下文独立 opt-in 测试；未提供 URL/DB 的 SKIP 不能报告 PASS。候选证据经审阅后，公开查证与独立预检/写入仍分别处理。

证据转存是单独授权步骤。queryBusList 的每个原始结果或批量 `segments[]` 应用 `lib/platform/recognized-evidence.ts` 的 `recognizedResultToImport` 转换，再用同一幂等键统一预检/提交，并通过 REST 历史或 `list_platform_queries` 读回全部查询/行 ID。不能重放实时查询来填补归档缺失的原时间或末页证明，见[转存契约](../../../../docs/platform-recognized-evidence.md)。

合成写入、读回和回滚校验（临时 SQLite，无真实账号）：

```sh
MIIT_COOKIE='' MIIT_COOKIE_FILE='' pnpm test tests/platform-recognized-evidence.test.ts --no-file-parallelism
```

这只验证合成转存，不代表生产归档回填或 UI 验收。

主体事实例子在 [enterprise-facts.mjs](enterprise-facts.mjs)，载荷与完成条件见[公开协议](../references/enterprise-facts.md)。调用者提供已初始化 SDK 客户端的 `call(name,args)`，它必须检查 `isError` 并解码 JSON，不能把 MCP 错误文本当正常返回。分别调用 `prepareFactCommand` → 持久保存 prepared → `commitPreparedFact`，每次确认/更正/撤回都是新的明确动作；`confirmedFactReferences` 选择多个当前确认版本，`saveReferencedDecision` 精确读回保存版本。函数不读取 Cookie，不启动任务，不自动重试或确认。

真实工具发现/SDK传输验证需要先启动指向专用合成 SQLite 的应用，测试本身不构建、不启动服务。限定 loopback、`/tmp/issue-307-*`（macOS realpath 可为 `/private/tmp`）专用目录；同一服务须配置 `NUXT_DB_PATH` 为下面的合成库，`NUXT_API_TOKEN` 与 `NUXT_MCP_TOKEN` 为同一合成任务令牌。测试只用 SQLite 播种企业身份，其余生命周期/决定操作全部通过实际 `/mcp`，再用 REST 对照读回：

```sh
FACT_PROTOCOL_307_URL=http://127.0.0.1:43874 \
FACT_PROTOCOL_307_DB_PATH=/tmp/issue-307-skill-consumers/synthetic.db \
FACT_PROTOCOL_307_TOKEN=synthetic-fact-protocol-307 \
pnpm exec vitest run tests/enterprise-fact-protocol-307-mcp.test.ts --no-file-parallelism --maxWorkers=1
```

未提供 URL/DB 时这三个传输测试明确 SKIP，不能报告 PASS。JSON 读回存到合成库旁的 `mcp-fact-protocol-readbacks.json`，不得提交；此验证不代表生产数据、真实平台、UI、导出或独立代理盲测验收。
