# #195：三个输入边界的限时调查

母票：[#190](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/190)；本票：[#195](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/195)。scope:spike，90 分钟上限；仅交付报告，不修改生产代码、公共契约、数据库历史或 CI，不创建后续 issue。

## 结论

确认一项 **P2 页面恢复缺陷**：保存的导出请求身份与错误任务号组成合法形状时，即使重提收到同一请求身份的真实 202 回执，旧任务号仍留在会话存储中。返回查询页后的“查看本次导出”再次打开错误任务。其余探针证明了现有拒绝/回退路径；未发现本次无效 OCR 缓存生成正式事件、改写差异决定或丢失原始平台事实。

嵌套平台字段被字符串化、单个 1 MiB 平台字段及 OCR markdown 被接受，属于已观察到的宽松边界，尚不足以声称业务决定错误或容量故障。不要据此全面更换 schema。

## 代码与环境

- 固定被测源码：`c22aab2f4788eb7b1c287f89dd41f0ad27731fbd`。当前工作树起点与指定集成基线相同，干净后新建 `t3/spike-195-input-boundaries`；未 reset 共享分支。
- 取证窗口：2026-10-22 02:27–02:43 UTC，约 16 分钟；随后仅整理交付和 Git 收据，未用满 90 分钟上限。
- 从 `git archive` 建立 `/tmp/ningbo-spec190-handoff/issue-195/source/`，按锁文件安装依赖。Nuxt dev 使用归档源码、新建 SQLite、合成 PDF、独立文件目录、合成 HTTP/MCP/OCR 凭据和不存在的 dotenv 路径；子进程不继承业务环境变量。
- 平台替身通过临时 `NODE_OPTIONS --import` 钩子将平台主机请求改投 loopback HTTP，其他请求保持原样；OCR 使用仓库已有本地替身。客户端请求实际经过 Nuxt HTTP 路由；MCP 请求实际经过 `/mcp`。没有连接真实平台或生产服务。
- 先读取 GitHub 两票、AGENTS、GLOSSARY、相关诊断/测试/Nuxt/浏览器技能，并保存运行时 `/_openapi.json`，再执行合成写入。`scope-gate` 的 spike 交付边界与票面一致；未分派。

## 1. 浏览器保存的导出请求身份

消费链：`sessionStorage[task-center-export-requests-v1]` → `useExportRequestLog.read()` → `useCurrentRosterExport.submitExport()` → 专用导出 POST / 当前任务链接。

现有检查：称号及 initial/重生成任务键、36 字符身份模式、ULID 任务号；恢复时只取身份和任务号。挂载异常被捕获，提交前重新读取；读写失败先阻断 POST。服务端身份契约是长度 1–128 的字符串，并不要求 UUID；36 个 `-` 被客户端和真实 HTTP 接受，不能仅凭变量名认作契约漏洞。

| 有限输入 | 新鲜公开行为 |
| --- | --- |
| 坏 JSON `{bad`、JSON `null` | 页面仍可用；点击显示“无法保存请求标识，本次未发送导出请求”；实际导出 POST 为 0，原值保留。未自动修复，属于现有保守拒绝行为。 |
| 顶层 `[]`、身份/任务号为数字、未知键 | 无效条目忽略；点击生成合法新身份，真实 POST 202。 |
| 有效身份附带 1 MiB 无关字段 | 恢复并沿用该身份；提交后存储收敛到身份/任务号，约 120 字符；不传额外字段。 |
| 另一称号 initial、旧重生成上下文 | 不挪作当前称号 initial 身份；POST 使用独立身份。 |
| 合法形状但错误的当前任务号；附带伪造 status/downloadUrl | 只恢复身份/任务号；真实 202 的任务号用于当次导航；**旧任务号仍写回并用于下次恢复**。附带状态/地址不进入 POST。 |

### 已确认反例与最窄后续建议

最小存储输入（先以该身份创建一次真实导出，以获得服务端规范回执）：

```json
{"little_giant:initial":{"clientRequestId":"19500000-0000-4000-8000-000000000001","jobId":"01M5BEPVCXD5619ZW4C6CATRET"}}
```

重提沿用上述身份，服务端返回真实任务 `01M5GQJA4YZY0H80XNAJRH75HN`，当次也导航至该任务。返回查询页，“查看本次导出”却仍指向 `01M5BEPVCXD5619ZW4C6CATRET`，详情显示“详情加载失败或任务不存在”。桌面与 390px 均复现。未观察到重复任务、权限绕过或正式数据污染。

原因：[`useExportRequestLog.ts:51–58`](../../composables/useExportRequestLog.ts) 的 `remember()` 在身份相同时，最后展开的 `current.jobId` 覆盖真实新回执；[`useCurrentRosterExport.ts:44–53`](../../composables/useCurrentRosterExport.ts) 验证 202 后调用该路径，返回值与持久化值因此分离。

建议后续 **scope:S、独立修复**：区分“保存待确认身份”与“接受服务端已确认回执”，仅允许同一当前身份的已验证 202 更新任务号；继续拒绝旧身份覆盖新身份、保留未确认请求身份和存储失败的拒绝行为。验收应包含真实 202 → 返回/刷新 → 链接与任务详情一致，以及旧异步回执、重复点击、丢失回执的已有保护。本票未修复、未建票。

## 2. 平台接口返回封套

消费链：真实上游 HTTP 文本 → `assertSessionAlive()` → `parsePlatformList()` / `parsePlatformPage()` → `runPlatformLiveQuery()` → `/api/platform/query`、`query_platform`。代表来源为 `queryBusList`、单称号 `2`、pageSize=2、最多 3 次请求/6 行/10 秒。

| 有限输入 | 新鲜公开行为 |
| --- | --- |
| 正常空页 total=0、正常单行 | 分别为 HTTP 200 + `no_record/complete`、`success/complete`；HTTP 200 本身不表示业务成功。 |
| 坏 JSON、null、错误 grid、非数组 pageSet、null 行 | `failed/partial`，保留 unfinished；不是 `no_record`。非数组 pageSet 在 MCP 同样为 failed。 |
| 声明 2 行却仅返回 1 行；返回行数超过请求 pageSize | `failed` + `invalid_response`；不纳入不一致页。 |
| 第一页 2 行/total=3，第二页坏 JSON | `partial/partial`，保留前 2 行、declaredTotal=3、第二页 unfinished。 |
| 过期会话 statusCode=301 | `auth_failed/partial`，不当作完整无记录。 |
| maxCount 为 `oops` 或缺失，但 page=1/pageSize=2/maxPage=1、空行数组 | `declaredTotal=null`，仍以该末页边界结束为 `no_record/complete`。这是已测到的现行规则，不能写成“总数为 0”。若要拒绝畸形 total 而允许缺失 total，须先明确兼容规则；本票未裁定这构成业务缺陷。 |
| `qymc` 为对象 | 公开结果 `success`，字段变为 JSON 字符串 `{"unexpected":"nested"}`。现有 normalizeRow 的兼容转换，不是逐业务字段校验；本次未进入正式认定/差异决定。 |
| 单字段 1 MiB | HTTP 200，完整返回 1,048,576 字符；行数/请求数有限不等于字节预算。未做 OOM/并发/SLO 结论。 |
| 入口请求本身为坏 JSON、null、name 数字、name 1 MiB | HTTP 400，上游调用 0。坏 JSON 错误体缺少 code，未误报成功。 |

已有保护不是 TS 断言提供的：行数组形状、页号/页大小/总数一致性、凭据脱敏和操作上限均在运行时执行。建议只保留“核心身份字段的类型与原文保留策略”“单响应读取/返回字节预算”两个待确认方案；先明确外部兼容输入与预算，再决定是否分别立票，不扩大成全平台 schema 迁移。未验证 legacy `classifyPlatformResponse` 的全部消费者，不能把本次 live 结果推广到它们。

## 3. OCR/解析派生缓存（代表：OCR 成功页中转）

消费链：隐藏页图目录 `.ocr-cache/<key>.json` → `readOcrPageCache()` → `runOcr()` → 真实 `POST /api/jobs` → 终态任务 → `/api/ocr-results`，并抽查 `get_ocr_result` MCP。缓存只提供 OCR 页结果，不具有正式事件或差异决定写入权限。

| 有限输入 | 新鲜公开行为 |
| --- | --- |
| 坏 JSON、null、顶层数组、markdown 数字 | 缓存未命中，每例真实调用本地 OCR 替身 1 次；任务 done、cachedPages=0，公开读回 `FRESH_OCR195`，不是无效缓存内容。数字字段例 MCP 亦读回新识别文本。 |
| 旧版本、错误页图哈希、旧模型选项指纹 | 同样未命中并重新识别；未复用过期上下文。 |
| 日期很旧但版本/哈希/选项均一致 | cachedPages=1、不调用替身；按内容身份命中，不以日期作为 TTL，排除“旧日期就一定无效”的候选。 |
| 有效身份下 1 MiB markdown | 命中并公开读回 1,048,576 字符；没有缓存字节上限。未证实内容丢失或容量故障。 |

补充非空状态验证：预置 1 条正式事件、1 条差异决定及 1 条带原始文本的平台查询，破坏缓存后再从真实 HTTP 提交 OCR。重识别成功；三类记录及平台关系的前后摘要均为 `f1482b65f663e0c519cdf0a71cb12a48da37f51b3958960732ffbc59177f1c72`，公开企业详情前后深相等。此合成夹具通过独立新建 SQLite 准备，不代表生产数据审计。

本边界不建议追加生产修复。缓存 raw 是 opaque 原始响应，不应仅因 unknown 就强行约束其内部 schema。独立的页图 manifest、持久化解析声明、reconcile 文件、平台 summary cache 和历史 DB JSON 不在这次代表样本运行范围内；没有对它们给出 PASS 或批量修复建议。

## 命令、证据与限制

完整 harness/日志/合成数据均在 `/tmp/ningbo-spec190-handoff/issue-195/`，Git 只提交本文。主要复现入口：

```sh
git archive c22aab2f4788eb7b1c287f89dd41f0ad27731fbd -o /tmp/ningbo-spec190-handoff/issue-195/source.tar
# source/ 解包后执行；锁文件不变
pnpm install --frozen-lockfile
node /tmp/ningbo-spec190-handoff/issue-195/source/node_modules/vitest/vitest.mjs run --config /tmp/ningbo-spec190-handoff/issue-195/vitest.config.ts
node /tmp/ningbo-spec190-handoff/issue-195/source/node_modules/vitest/vitest.mjs run --config /tmp/ningbo-spec190-handoff/issue-195/supplement.config.mts
ego-browser nodejs -e 'await import("file:///tmp/ningbo-spec190-handoff/issue-195/browser-round3.mjs")'
ego-browser nodejs -e 'await import("file:///tmp/ningbo-spec190-handoff/issue-195/browser-round5.mjs")'
ego-browser nodejs -e 'await import("file:///tmp/ningbo-spec190-handoff/issue-195/browser-round6.mjs")'
```

浏览器脚本绑定当次服务与 TaskSpace，重跑需先启动服务并更新地址/空间；`browser-done` 是主 harness 的有界关闭信号，不是可无条件重复执行的长期测试设施。

- **新鲜**：`results.json` 的 15 个平台封套、4 个请求体负例、MCP 抽查、9 个 OCR 缓存输入及不变量；`browser-results.json` 的 8 个恢复输入；`stale-receipt-repro.json` 最小反例；`browser-390.json`；`existing-invariants.json`；两份单文件 Vitest 运行结果。通过的是观察断言，已确认的页面缺陷仍未修复。
- **继承**：仅复用仓库既有合成 PDF、OCR 替身和服务启动/关闭 helper。没有将旧测试通过数继承为本次验收结果。
- **失败/纠正**：最初缺依赖启动、配置导入路径和夹具表名错误；浏览器脚本语法和将状态提示误按 alert 等待的错误，均在 `/tmp` 保留。T3 预览两次 snapshot 返回 `Preview automation snapshot timed out after 15000ms.`，另有导航传输错误；随后按工具规则回退 ego-browser。未把这些工具/夹具失败归为产品缺陷。
- **未运行/未知**：完整套件、typecheck、生产 build、prod-openapi、CI、真实平台会话、生产、容量/并发、其他来源/全部缓存及整个母票联合验收。未改公开契约；本次是 dev HTTP/MCP 和真实浏览器合成取证，不是生产构建验收。无全套并行争用。

交付收口已合入本地 `t3/implement-spec-190` 的 `678bba97e5e217ef1bafdea760a2eeb328b8a809`，合并提交为 `5e0c332ceda605f8bf01a755f94f8a0c6238cb5d`；最终 SHA 与清洁状态见外部 `git-receipt.json`。相对集成分支只有本文变更。本报告的行为证据只绑定上列固定源码；集成带入的 #191 工具配置变更未重跑，不自动升级为集成树的运行证据。
