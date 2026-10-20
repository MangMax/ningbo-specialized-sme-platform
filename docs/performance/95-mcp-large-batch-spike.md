# #95：大批 MCP 载荷边界与原子交付调查

2026-10-20；调查基线 `fc37375eb35ecd175a5746d93dc22129d2a2ffe3`。对应 [#95](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/95)、[#94](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/94)、[#88](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/88)。本票是 `scope:spike`：只交付契约、合成库公开接口复现和方案判断。运行脚本不会连接业务库；本票没有修改 SDK、生产处理代码、请求上限或 schema。

## 当前公开契约

| 入口 | 凭据 | 容量与失败 | 恢复 |
| --- | --- | --- | --- |
| `POST /mcp`，`preflight_roster_batch` | 按现有分类无需 MCP token；预检会建立批次账本 | 锁定的 SDK `@modelcontextprotocol/sdk@1.32.1` 默认整条 HTTP 请求体最多 `4,194,304` 字节，**包括 JSON-RPC 包装**。超过时公开状态 `413`、JSON-RPC 错误码 `-32000`、消息 `Payload Too Large: Request body must not exceed 4194304 bytes`；tool 不执行。不要将其解释成预检通过。 | 保留原始完整载荷和同一 `idempotencyKey`，取得 **HTTP 自己的**授权后转到 HTTP 预检。先读该 key 的回执确认状态；未知或断线时继续按同键恢复。 |
| `POST /mcp`，`save_roster_batch` | `NUXT_MCP_TOKEN`；HTTP token 不能代替 | 同一 SDK 请求体边界；无有效 MCP token 时写 tool 返回 `401`。 | 适用于未超过 MCP 容量的调用。不要把一批拆成多个提交。 |
| `POST /api/roster/import/preflight`、`commit` | `NUXT_API_TOKEN`；MCP token 不能代替 | 当前路由没有对应的显式 `4 MiB` 上限，仍会整体解析 JSON；这**不等于**任意大小可用，也不排除部署层上限。缺少或错用 HTTP token 返回 `401`。 | 先完整预检，确认冲突，再以同一完整 body 和 key 提交。预检只写账本，不写业务行；提交保持整批事务。断线先按 key 读回执，再同键重试；已提交的同键请求返回原提交结果，不产生新的业务写入。 |
| `GET /api/roster/import/receipts?idempotencyKey=...`、MCP `get_roster_import_receipt` | 分别要求 HTTP / MCP 自己的 token | 未建立批次返回 `404`；回执状态可为 `preflight`、`processing`、`failed`、`committed`。 | `413` 后不能假定 key 已占用或已成功；以授权读回为准。`processing` / 断线不能当成功；核对回执与来源读回。 |

SDK 源码 `server/requestBody.js` 的默认值为 `4 * 1024 * 1024`，`webStandardStreamableHttp.js` 在工具调用前回 `413`。本应用的 MCP middleware 还会通过 `readBody` 检查工具名；本调查只证明**工具未执行和回执未产生**，不能把 SDK 的 413 当成“整个服务只分配了 4 MiB”的内存证明。HTTP 与 MCP 两个 token 在代码中分别由 `server/utils/api-auth.ts` 和 `server/utils/mcp-auth.ts` 校验；即使部署者配置了同值，客户端也不得假定两条通路共用凭据。

## 可重复的公开接口证据

执行 `pnpm install --frozen-lockfile && pnpm build`，再执行 `SOURCE_SHA=$(git rev-parse HEAD) node scripts/verify-mcp-large-batch-95.mjs`。脚本创建并销毁自己的合成 SQLite、随机且不同的两颗测试 token、本机 Nitro 子进程；读写只经公开 HTTP/MCP。输出不含 token、原文和数据库。需要先构建当前源码，不能指向共享服务或业务数据库。

在上述 SHA 的一次完整运行中，300 个合成输入行（299 个约 14,753 字节原文、1 个 1,200,000 字节原文）的 HTTP body 是 `5,625,741` 字节，MCP JSON-RPC body 是 `5,625,843` 字节。脚本验证：

1. 用合法 `tools/list` JSON 后的空白填充请求体：恰好 `4,194,304` 字节得 `200`，多 1 字节得 `413`。MCP token 调 HTTP 预检和 HTTP token 调 MCP 写入均得 `401`；无 MCP token 的超限预检得 `413/-32000/4194304`，同键授权 HTTP 回执读为 `404`。
2. 同一**完整**载荷和 key 经 HTTP 预检得到 `preflight`，随后 HTTP 提交得到 `committed`、`written=301`（1 批次 + 300 原行）、`failed=0`。提交前回执为 `preflight`，提交后为 `committed`。
3. 公开来源接口对 6 个位置（首行、超大行两侧、200 行分片两侧、末行）读回原文与行号；300 个提交行 ID 全部唯一。MCP 授权回执与 HTTP 回执一致；HTTP 同键重放返回逐项相同的提交结果，回执历史仍为预检和提交两条，没有新增尝试或业务行。

这里是**功能与恢复**的一次合成库运行，并非 p95、容器、生产或全量规模验收。之前 `docs/snapshot-ingestion-performance.md` 的 `after-final-large-http` 在另一源 SHA、5 并发读 + 1 写、20 热样本上记录了 HTTP 延迟和资源观察；这些属于继承证据，不能宣称是本 SHA 的新性能通过。#94 的完整 2x/5x 与容器等剩余验收仍独立。

## 方案比较与选择

| 方案 | 原子性、内容及恢复 | 资源/运维成本 | 结论 |
| --- | --- | --- | --- |
| **保留 4 MiB MCP 上限，超限时走已授权 HTTP** | 两入口复用同一领域导入、整批事务、预检绑定和同键回执；原文、行序、逐项错误随完整 body 保留。客户端必须显式拥有 HTTP 凭据，不能用 MCP 凭据冒充。 | 现有 HTTP 整体 JSON 解析，单项/总量尚无入口级有界流式保证；需在调用端控量，并继续完成受控规模/容器门槛。无新存储、清理队列或 API 迁移。 | **本票推荐**。已有 5.63 MB 合成场景的真实接口恢复证据，生产接口零改动。 |
| 受限扩大 MCP 请求容量 | 单次 MCP 调用可保留原子批次；必须同时保证预检、提交、回执路径一致。 | 单改 SDK `maxRequestBodySize` 会放大全体 MCP body，且应用 middleware 仍预读 JSON；需要提前拒绝、单次解析/保压、最大单项、并发限制和 1/2/5 读写矩阵。必须重做安全、内存和 loop 验收；不能直接按 5.63 MB 加大常数。 | 暂不实施；只有确实要求 MCP 独占写入且 HTTP 凭据无法提供时再立项。 |
| 上传后引用式批次 | 可先传完整对象，再用稳定摘要/引用绑定 key 与预检计划，最终一次事务提交；分片仅用于**传输**，不能分成业务提交。 | 新上传生命周期、租约/过期清理、权限、校验、失败恢复、存储配额和垃圾回收；潜在 schema/migration 所有权需另定。 | 当前 5.63 MB 场景不值得引入；更大长期载荷需求先单独做协议设计。 |

**推荐的调用侧工作包络**（不是当前服务器强制上限）：一批最多 300 行；本场景 HTTP 序列化 body 暂以 `<=6 MiB` 为客户端拒绝/复核阈值，单项原文 `<=1,200,000` 字节；MCP 的 `4,194,304` 字节是**整个 JSON-RPC body** 的实测拒绝边界。HTTP 实测样本为 `5,625,741` 字节，`6 MiB` 边界本身未实测。客户端一次只发送一个写批次，等待完整预检/提交/回执后再送下一批；与读流量并行的目标沿用 1/2/5 个读请求。不得截断单项、丢弃原文或将同一逻辑批次拆成多个 commit。超过该包络时先停止并另行量测，不能默许无限 HTTP body。

**冻结预算，不因方案调整而放宽**：`docs/performance/82/budgets.md` 的 Node old space `2048 MiB`、批次 heap 增量 `<=256 MiB`、预检 p95/p99 `<=3/6 s`、提交 p95/p99 `<=5/10 s`、交互 event loop p95 `<100 ms` 且 max `<500 ms`，无 OOM、进程 heap `<1.8 GiB`、RSS `<3 GiB`。当前本机一次功能运行不评价这些分位数或 1 vCPU/4 GiB 容器。#94 已有的顺序内部写片（最多 200 行、编码字节最多 1 MiB；超大单项独占片）仍属于**同一个事务**。

本方案不需要生产实施切片。若后续确有 MCP 独占且超过 4 MiB 的需求，先另开 `<=M` 的协议/入口防护切片（在应用 middleware 前拒绝、明确 body/单项/并发与鉴权错误），再开独立 `<=M` 的合成规模/容器验收切片；需要上传引用时先做独立 Spec/ADR，再把上传、引用绑定与清理分别拆为可审切片。#88、#94、#91 的剩余验收不随本调查自动完成。
