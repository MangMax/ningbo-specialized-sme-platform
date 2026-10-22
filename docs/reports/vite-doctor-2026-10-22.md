# Vite Doctor 接入与体检交接（#191）

日期：2026-10-22。父规格：[#190](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/190)。
代码基线：`c22aab2f4788eb7b1c287f89dd41f0ad27731fbd`。复用同基线工作副本的 README、Nuxt 模块、三个命令与锁文件；未修改来源工作树。
本文件是小型交付摘要，原始报告不入 Git。

## 复现

使用项目要求的 Node 24 与 `pnpm@12.11.2`，从仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm exec nuxt prepare
pnpm check:doctor --no-cache --no-server
pnpm check:doctor:structure --no-cache --no-server
```

框架规则与结构分析要分别执行；`--analyses dead-code,graph,dupes,health` 只选择结构分析，不包含默认框架规则。
`--no-cache` 禁用本轮持久分析缓存，`--no-server` 强制在当前进程运行。
CLI 4.0.1 的 `nuxt --help` 未列出 `doctor` 子命令，因此本项目使用实际验证过的 package scripts。

纯 JSON 重定向示例（先创建输出目录，保留退出码；两条扫描独立运行）：

```bash
report_dir="$(mktemp -d /tmp/ningbo-doctor.XXXXXX)"
pnpm --silent check:doctor:json --no-cache --no-server > "$report_dir/framework.json" 2> "$report_dir/framework.stderr"
framework_status=$?
pnpm --silent check:doctor:structure --no-cache --no-server --format json > "$report_dir/structure.json" 2> "$report_dir/structure.stderr"
structure_status=$?
printf 'framework=%s structure=%s reports=%s\n' "$framework_status" "$structure_status" "$report_dir"
```

交互式 shell 中逐条执行；若包装脚本启用了 `set -e`，需显式捕获扫描的非零状态，以便继续第二类扫描。
本次扫描均为退出码 1、JSON 可解析且含诊断，表示发现错误；任意非零状态本身不能证明扫描完成，仍须检查 stderr 和报告。
不要用 `--fix`、baseline、规则关闭或删除“未使用”模块来制造通过。

固定开发依赖为 `vite-doctor@0.1.0`，使用[官方 Nuxt 模块](https://github.com/onmax/vite-doctor#configuration) `vite-doctor/nuxt`。
模块收集解析后的项目清单 `.nuxt/doctor.manifest.json`；普通构建没有追加扫描命令，生产运行不执行体检。
SPA、路由、业务接口、事务、部署配置均保持原样。

## 原始结果与人工核实

继承的首次结果（来源工作副本，同一基线加工具接入，均识别 819 个文件）：

- 框架：14 error / 383 warn / 328 info，退出码 1。
- 结构：3 error / 276 warn / 257 info，退出码 1。
- 合计 1,261 条静态诊断，不等于已证实缺陷数或业务验收结果。

人工代码核实摘要已在本工作树复查：

- 3 处直接从 vue-router 读取 useRoute：`composables/useOcrNavigation.ts`、`pages/comparison.vue`、`pages/enterprises/[id].vue`。存在与 Nuxt 包装器的语义差异；本票未复现用户可见故障，修正属于 #192。
- 9 处浏览器全局提示需考虑 `ssr: false`；不能称为当前 SSR 崩溃。247 条显式导入与 328 条目录放置提示也不自动要求迁移。
- SafeHtmlPreview 使用 DOMPurify，CodePreview 的高亮 HTML 来自 Shiki；静态 v-html 告警不等于已证实注入漏洞。
- 结构扫描报告无法解析的 `tests/helpers/minimal-pdf.ts` 实际存在，三个验收脚本引用它；不创建重复辅助文件。
- decision-lifecycle-102 与 evidence-impact-113 确有双向导入，属于 #196。请求配置、侧栏属性透传和反序列化提示分别由 #193–#195 调查，本票不改动。
- 复杂度计数、重复片段和未使用文件/依赖提示不能直接证明生产性能问题，也不能据此删除动态 worker、Nuxt 模块或独立 CLI。

## 验证证据边界

本次新鲜验证使用 Node `24.18.0`、pnpm `12.11.2`；实际解析 Nuxt `4.6.1`、Nitro `2.13.4`、H3 `1.15.11`、Vue `3.5.43`。
原始记录统一保存在 `/tmp/ningbo-spec190-handoff/issue-191/`，最终 SHA、树和集成同步收据见该目录的交接文件。

- **新鲜**：冻结安装和显式 Nuxt prepare 通过；框架脚本与 JSON 脚本输出均可解析，两者都是 5 error / 392 warn / 328 info；结构脚本为 3 error / 276 warn / 257 info。均覆盖 819 文件、退出码 1，不宣称零告警。
- **新鲜通过**：`pnpm typecheck`（27.465 秒）和 `pnpm build`（15.440 秒）均退出码 0。生产产物的 JS/MJS/JSON 文件未检出 `vite-doctor` 字符串；这是产物检查，未启动生产服务。构建仍有 EmbedPDF crypto 外置、render-worker URL、大 chunk 与插件耗时警告，未开展这些路径的浏览器验证。
- **差异保留**：本次框架扫描的 9 条浏览器全局诊断为 warn；继承的首次结果为 error。总数不变，来源报告也曾记录同样的严重级别变化。本票没有改这些业务源码，也不把工具上下文造成的等级变化称为修复。
- **继承失败**：首次完整串行测试退出码 1；246 文件通过 / 2 失败 / 1 跳过，3,056 测试通过 / 2 失败 / 5 跳过，另有 25 次 ENOENT 未处理异常。原始日志和元数据见 `inherited/raw/tests.log` 与 `inherited/raw/verification.json`。
- **继承定向通过**：仅补齐固定临时目录后，两文件 29/29 通过、退出码 0；没有第二次全量通过证据。目录隔离属于既有 [#124](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/124)，本票不修改测试或该票状态。
- **未运行**：本票不重跑完整测试，不进行浏览器、HTTP/MCP、真实数据、安全专项、容量、CI 或生产验收。未改变公开契约，未运行 prod-openapi。

原始诊断及继承核实记录保存在 `inherited/`；新鲜命令、时间、退出码见 `fresh-runs.json`，扫描 JSON 与 stderr 分别保存。
锁文件审计见 `lock-audit.json`：既有直接依赖声明与解析版本变化为 0；既有包版本无删除、既有包元数据无变化；新增 102 个工具相关包版本，其余大段变化为 peer 上下文重写。
