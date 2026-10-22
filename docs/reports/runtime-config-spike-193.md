# #193 请求配置与后台配置调查

父规格 [#190](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/190)；调查票 [#193](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/193)。仅文档交付，无生产代码或测试改动，无新 issue、push、PR 或部署。

## 结论与边界

- **当前进程配置模式：未复现跨请求配置/鉴权串用。** 独立 REST/MCP 请求分别接受各自的进程凭据；前一次合法 MCP 调用没有使后一次无凭据调用获权。无 event 的后台 OCR 可按现有明确来源完成任务。
- **可复现的条件性差异：现有无 event 调用忽略请求覆盖。** 在隔离副本的真实 HTTP 中间件中，仅修改本次 `useRuntimeConfig(event)`；A/B 交错请求各自配置正确，但现有文件预览、名录 HTTP/MCP 鉴权、OCR resolver、页面复核开关仍读取进程配置 G。包括请求配置清空 token 时，G token 仍可写。**没有找到当前 `server/`、`lib/`、`db/` 中设置请求级 runtimeConfig 的生产路径，不能据此宣称现部署存在跨租户漏洞或已确认线上故障。**
- **需要裁决：凭据“只在服务端”与现有 reveal 契约冲突。** 普通配置状态、任务详情/摘要、回执及解码后的原请求均通过脱敏验证；但既有 `POST /api/settings/credentials/ocrToken/reveal` 明确无需管理 token，实测返回有效合成凭据原值且 `no-store`。这是现有公开契约支持的行为，不是本票新引入的泄漏。不能将其归入“所有响应永不返回凭据”；需决定保留显式查看例外，还是另行授权调整该契约与页面权限。
- **无行为差异的写法建议：** 在固定进程环境、无请求覆盖的这些链路中，传不传 event 取得相同有效配置。不要仅为清除 44 条静态提示修改后台路径。该结论不覆盖所有调用、动态环境变量轮换、多租户或其他部署适配器。

## 固定对象与隔离方法

新鲜行为证据基线：`c22aab2f4788eb7b1c287f89dd41f0ad27731fbd`，tree `1bae157a7f0da53e5e8a006378b8a7fa9fd5227d`。Node `24.22.1`、pnpm `12.11.2`、Nuxt `4.6.1`、Nitro `2.13.4`、Vitest `4.1.11`，使用 frozen lockfile；不套用 Nuxt 5/Nitro 3 的不同语义。

在 T3 已分配的隔离工作树创建 `t3/spike-193-runtime-config`，未 reset 共享工作。交付前已合入当时本地 `t3/implement-spec-190`：`678bba97e5e217ef1bafdea760a2eeb328b8a809`（fast-forward）。相对调查基线仅 #191 开发工具交付发生变化，`git diff c22aab2 678bba9 -- server db lib` 为空。下述测试是基线上的**新鲜运行**；在该集成对象上为**继承证据**，没有声称已重跑新的依赖图。

全部脚本、完整报告、请求记录、日志、SQLite 和生成文件位于 `/tmp/ningbo-spec190-handoff/issue-193/`。`run-2/app` 来自 `git archive`，只额外加入调查专用中间件、遥测路由、后台 timer 插件；真实业务路由/核心不变。中间件使用真实 H3 event，A/B 配置仅写本次 event，绝不按请求改 `process.env`。后台由启动插件的 interval 读取文件指令，未捕获/伪造请求 event，经现有 `submitJob` → `ocrSpec.prepare` → `runOcr` 执行。

服务进程环境采用 allowlist，所有路径、OCR 地址及凭据均为合成配置；上游只访问 loopback OCR 替身。另在未添加调查插件的本地编译产物上完成 6 项 HTTP/MCP smoke。没有访问活动业务库或真实平台。

## 三条配置生命周期

| 链路 | 当前配置来源与生命周期 | 证据及限制 |
| --- | --- | --- |
| 文件读取/维护 HTTP | `files/[...path].get.ts:29` 每次调用无 event 配置；版本化维护经 `api-guard.ts:15` 读取进程 API token；restore 在 `files/[id]/restore.post.ts:26` 读取进程文件根。TUS 文件根也来自无 event 配置（`tus.ts:120`）。 | 两个独立读取均返回 G 文件字节；合法 G API key 的版本化元数据维护成功，MCP key 被拒。A/B 文件预览仍取 G。restore/TUS 的覆盖与缓存生命周期只追踪源码，未跑恢复/上传全链路。 |
| 名录 HTTP/MCP | HTTP `roster-import-route.ts:24` 的无参依赖工厂通过 `core-route.ts:62` 调用，取进程 token/root；MCP 中间件 `server/mcp/index.ts:96` 将鉴权结果放**本次** `event.context.mcpAuth`，`writeGuard` 据此注册工具；`save_roster_batch.ts:69` 再取进程 root 校验 PDF 页数。DB 是 `db/client.ts:19` 的显式 dbPath → `NUXT_DB_PATH` → cwd 默认，不是请求级配置。 | REST/MCP 真实提交、拒绝、REST 幂等重放、工具可见性成功。配置覆盖实验中，A/B key 被拒而 G key 成功；request-empty 也仍接受 G。没有证明多租户 DB 隔离，也没有此部署承诺。 |
| OCR 后台 | `credential-state.ts:29`：显式非空 override → DB 保存值 → runtime `ocrToken`/`NUXT_OCR_TOKEN` → Paddle 环境变量 → 空。baseUrl：runtime → NUXT 环境 → Paddle 环境 →默认；model：runtime → NUXT →默认。`ocrSpec.prepare`（`jobs/ocr.ts:389`）在提交时捕获已解析配置；队列保留 run closure 和显式 filesDir（`job-runner.ts:254`），不保留请求 event。 | timer 发起的实际 OCR 任务 done；保存值、显式覆盖、Paddle fallback 均有真实 loopback submit/poll/result。既有测试新鲜证明在途/排队任务沿用提交凭据，后续任务才读取新值。所有 OCR 凭据为空时无上游提交。 |

安装的 Nitro `dist/runtime/internal/config.mjs:10–23` 直接解释现象：无 event 返回深冻结的共享启动配置；有 event 则使用/生成 `event.context.nitro.runtimeConfig`。共享对象没有被 A/B 修改。12 个交错请求均取得各自 event 配置，后续无覆盖请求仍为 G；这不是请求之间互相污染，而是调用方选择了不同配置来源。

## 新鲜结果

| Requirement | Evidence |
| --- | --- |
| 文件读取与版本化维护 | `process-config-file-and-maintenance`：PASS；两个独立读取，错误 key 401 / 正确 key 200。 |
| REST/MCP 分离、幂等与请求鉴权生命周期 | `process-config-rest-and-mcp-write-isolation`：PASS；真实 committed、REST replay 相等、无凭据后续请求 401、tools/list 按请求鉴权。 |
| 请求覆盖隔离与条件性反例 | `request-overrides-interleaved-and-not-shared`、`request-overrides-rest-mcp-gates-ignore-effective-key`：PASS；12 个 A/B 交错请求；A/B/empty 的现有鉴权仍按 G。PASS 表示观察断言成立，**不是**认定忽略覆盖符合未来需求。 |
| 页面复核能力开关和请求来源 | `browser-gate-process-disabled-and-override-a-ignored`、`browser-process-enabled-origin-and-content-type-gates`：PASS；关闭 403、缺 Origin 403、跨站 403、非 JSON 415、正确同源进入输入校验 400；测试输入不是合法业务命令，不能据此声称业务写入成功。 |
| 普通输出脱敏与显式 reveal 例外 | `masked-settings-spec-and-spa-no-full-secrets`、`actual-job-and-import-receipt-redaction`、`documented-explicit-reveal-is-not-a-redacted-endpoint`：PASS；普通输出保留业务 marker 并移除已知合成秘密；reveal 200 返回原值。SPA 只检查初始 HTML，不替代浏览器网络/存储检查。 |
| 无 event 后台与优先级、空值关闭 | `background-ocr-process-config-without-request-event`、`saved-credential-and-explicit-override-precedence-background`、`paddle-fallback-without-request-event`、`empty-process-credentials-close-all-three-gates`：PASS；共 4 次 OCR submit、4 poll、4 result，空值阶段 0 submit；REST/MCP 401、页面写 403。 |

13/13 调查用例通过（`run-2/results.json`），脚本退出码 0。上游鉴权记录为每次 submit/poll 带相应合成 Bearer，返回的 JSONL 地址不带 Bearer；没有将凭据转发到结果下载地址。

既有定向测试：6 文件、77/77，通过，退出码 0。包括 `uses saved credentials for new OCR runs while a running submit and poll retain their startup snapshot`、`queued OCR retains its submission credential for submit and poll without persisting it in job history`，以及 Cookie 在途快照/下次热更新、凭据存储失败关闭、复核同源门禁、任务/回执脱敏。

`pnpm typecheck` 和 `pnpm build` 均退出码 0；build 有既有浏览器模块 externalization、chunk 与 plugin timing 警告，未修改阈值。未添加调查插件的编译产物 6/6 smoke 通过：运行时文件根、REST/MCP 分钥提交、OpenAPI 默认 404、页面写默认关闭、普通响应不回显 key。**本地 production-mode 产物测试不代表生产部署验收。**

失败证据保留：`run-1` 为 9 PASS / 3 FAIL、退出码 1；两处错误地要求 JSONL 下载也带 Bearer，一处把真实 `OcrImageOut.page` 错读为 `pages.length`。实际后台任务当时已完成。修正调查脚本后用全新目录重跑；没有改动产品源代码或删除失败日志。

未运行：全套测试、CI、真实浏览器桌面/390px、真实凭据/平台、生产部署、容量/SLO、所有 44 处配置提示逐点验证。公开契约未变，未运行 `verify:prod-openapi`；本地编译 smoke 的 404 仅证明默认关闭。父规格已有全套测试统计属于背景，不计入本票通过数。

## 复现

实际执行（全部在上述固定基线上）：

```sh
pnpm install --frozen-lockfile
node /tmp/ningbo-spec190-handoff/issue-193/run-spike.mjs "$PWD" /tmp/ningbo-spec190-handoff/issue-193/run-2
pnpm exec vitest run tests/credentials-api.test.ts tests/cookie-credentials.test.ts tests/ocr-job.test.ts tests/jobs-summary-http.test.ts tests/import-receipts-http.test.ts tests/evidence-review-108-browser-http.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm build
node /tmp/ningbo-spec190-handoff/issue-193/compiled-smoke.mjs "$PWD" /tmp/ningbo-spec190-handoff/issue-193/compiled
```

已存在的 run 目录不可复用。当前通用脚本另支持显式 `SPIKE_SOURCE_SHA=c22aab2f4788eb7b1c287f89dd41f0ad27731fbd`，供集成分支前进后重新 archive 该对象，并传入一个新的空输出路径；运行基线编译 smoke 前仍须在该固定对象构建。原始实际运行脚本副本是 `run-2/run-spike.mjs`，SHA-256 `f0a7ed4bfb8d11757f13fbc7fa89997cd27a53b515291d1ce511f46dee082f08`；`run-2/results.json` SHA-256 `dca605eb2c232ded5db0e3e1849885179748be489e177f9d935fb236a3dc83fa`。详细收据见外部 `REPORT.md`、`manifest.json`，不将调查脚本或 DB 纳入 Git。

## 必要后续建议（尚未建票）

1. **先裁决配置承诺与 reveal 例外。** 若仍为单实例进程配置，不需要为本票统一改写调用；明确后台用进程配置与已解析快照。reveal 是否保留独立裁决，不能通过顺手增加 auth 改变现有页面契约；真实身份能力可与 #127 对齐。
2. **仅在确认支持请求覆盖后扩展公共接缝（一个 ≤M 切片）。** `createCoreRouteHandler` 允许依赖工厂接收真实 event，旧零参数工厂仍兼容；凭据/OCR resolver 增加可选的明确配置与依赖参数，保留旧无参后台调用和显式 token 优先级。不引入模块级“当前请求”、伪造 event、逐请求改环境变量或新的 AsyncLocalStorage 机制。
3. **消费者迁移分开交付。** 先迁移文件 preview/restore 与名录 HTTP 鉴权/root，再迁移 MCP 中间件和有关工具。MCP tool handler 的 SDK extra 并不是 H3 event；当前 toolkit 支持 `(event) => tools` 动态定义，可用真实 event 构建每请求 closure，但需先验证注册/可见性兼容，不把 event 塞进 SDK extra。后台提交时显式捕获有效配置，继续沿用现有 prepare 快照。TUS 的进程服务实例和 DB 所有权语义须单独确认，不据此宣称已支持多租户。
4. **最终收口仅覆盖迁移链路。** 用本票 A/B/empty 反例要求正确 root、正确 key、空值关闭、脱敏器使用同一有效凭据集合；同时保留进程-only、无 event 后台及在途/排队快照测试。逐个迁移旧消费者后再考虑收紧可选参数；保留所有未覆盖/未裁决范围。无需预设“全仓 44 处清零”或新 CI 门禁。
