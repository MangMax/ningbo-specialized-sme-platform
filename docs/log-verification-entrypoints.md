# 日志验证入口

日志设置现为模块索引与 Sheet，旧根级 Accordion、HTTP/TUS 页签和 Card 密度布局已退役。当前实现见 [LogModuleRow](../components/logs/LogModuleRow.vue)。以下是保留入口与证据边界，不是运行通过报告。

## 当前入口

| 接缝 | 入口与用途 | 限制 |
| --- | --- | --- |
| Sheet 浏览器 | [verify-log-sheet-ui-180.mjs](../scripts/verify-log-sheet-ui-180.mjs)：桌面/390px、抽屉滚动与页脚、焦点、草稿、PATCH/GET 回读、容量 409 | 必须使用下述自有合成夹具；Chrome 已采用自有进程、端口 0 与私有启动标记校验，关闭进程组并等待 close 后移除 profile。Escape DOM 回退与合成 animationend 仍不证明原生按键或真实动画生命周期。 |
| API/容量夹具 | [verify-log-fields-ui-180.mjs](../scripts/verify-log-fields-ui-180.mjs)：新建隔离业务库与合成日志，保留独立字段清单、真实 HTTP/TUS 与容量冲突断言 | 正常 API 检查会消耗容量种子；给 Sheet 使用时须启用 server-only 模式。启动失败清理和生命周期仍有限制。 |
| 列表浏览器 | [verify-logs-ui-browser.mjs](../scripts/verify-logs-ui-browser.mjs)，自动启动 [verify-logs-ui-usability.mjs](../scripts/verify-logs-ui-usability.mjs) 的 `--serve` 夹具：骨架、分页、详情、失败导航、取消零写入 | 第 9/10 节已迁移到模块 Sheet，并检查确认前/取消零写入与精确 changed-only PATCH；夹具已绑定本次 SHA/tree、自有子进程及就绪标记。第 7 节在请求挂起及失败后精确比较完整有序行 ID，重试后比较两条 task.finished 合成记录的独立字面量身份。Chrome 同样采用自有进程、端口 0 与私有启动标记；清理等待 Chrome close、移除 profile，并等待夹具关闭及核对 closeout。这些实现状态不等于完整当前 UI 验收。 |
| 组件 | [logs-field-controls-ui.test.ts](../tests/logs-field-controls-ui.test.ts)、[logs-ui.test.ts](../tests/logs-ui.test.ts)：Sheet/草稿、精确部分载荷、冲突保留与列表状态 | happy-dom 与模拟传输不证明浏览器几何、原生输入、打包或真实 HTTP。 |
| HTTP | [logging-field-policy-http.test.ts](../tests/logging-field-policy-http.test.ts)：构建后 Nuxt、隔离夹具与请求关联事件 | 不覆盖浏览器布局；部分默认目录预期来自生产定义，不能替代容量夹具的独立字面量清单。 |
| 构建后运行时 | [verify-logging-foundation.mjs](../scripts/verify-logging-foundation.mjs)、[运行时日志说明](runtime-logging-181.md)；[verify-logs-ui.mjs](../scripts/verify-logs-ui.mjs) 提供 smoke/预览夹具 | foundation 保留重启/耐久性等独立用途；可选 ENOSPC 需专属挂载。预览夹具已等待自有进程关闭，再记录并断言最终业务字节一致性；closeout 失败返回非零退出码并保留诊断。该实现状态不替代真实运行时验收。 |

### 已集成修复的证据边界

[有序行身份 #545 的验收](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/545#issuecomment-6686928458)与 [Chrome 归属及清理 #546 的复核](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/546#issuecomment-6687483539)已随 `b3b7af55422b310a35dc32924efaa7a0dda8e399` 集成。两入口复用 [isolated-local-services.mjs](../scripts/lib/isolated-local-services.mjs) 的 `spawnOwnedChild`、`waitForChromeDevTools`、`stopOwnedChild`；重复信号清理保持幂等，启动/清理错误保留 stderr、各自 closeout 与非零退出码。列表夹具关闭超时仍按失败处理。

这些验收是继承证据（inherited），本次同步仅新鲜核对源码、链接与改动字节范围（fresh static）。#545 的非空错误行替换反例、#546 原重复信号泄漏 FAIL/BLOCKED 及后续修复复核各自保留；后来的结果不覆盖原失败。#546 最终复核使用合成 Chrome 启动/中断探针和真实合成夹具关闭流程，未重新执行真实 Chrome 桌面/390px UI；早前 UI 结果不能改记为当前运行 PASS。原生 Escape/动画仍为 UNKNOWN，下述 API/容量夹具启动限制也未由 Chrome 修复消除。本次测试、构建、HTTP 与浏览器均 UNRUN，不完成 #519/#516。

### Sheet 夹具准备

在明确授权的隔离验证中，从目标 checkout 启动
`F03_SKIP_CHECKS=1 node scripts/verify-log-fields-ui-180.mjs <worktree> <fresh-evidence-dir>`。
等待该次进程的 `SERVER_ONLY` 和 `f03-verify-manifest.json`，核对自有进程、隔离目录及 base，再将该 base 传给
`node scripts/verify-log-sheet-ui-180.mjs <owned-baseUrl> <fresh-outDir>`。
不得传入任意既有服务 URL、生产或真实业务数据；不得复用旧 manifest 冒充本次夹具。此模式跳过 API 检查以保留未裁剪容量种子，`SERVER_ONLY` 不是 PASS。运行者须保留首个失败诊断、后续结果并回收自有服务；这里不认证现有 harness 的运行就绪性。

## 历史入口与恢复

以下固定快照保存退役源码全部字节（含原失败诊断与历史注释）：

- [旧字段 Accordion 浏览器旅程](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/7bdefe40c4eb0e9eab896d790b87e76edc7eaec1/scripts/verify-log-fields-ui-browser-180.mjs)，blob `a9e9ea897d5663d619af85b17b9a34560623794c`。
- [旧 Card/Tab 布局测量](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/7bdefe40c4eb0e9eab896d790b87e76edc7eaec1/scripts/verify-log-settings-layout-180.mjs)，blob `0d9000a92b3094158a23082c176b3a4d21c04ffb`。

快照提交已经引入 Sheet；它保存旧脚本源码，不保证脚本能在该提交或当前应用运行。历史复现需另选 pre-Sheet 应用版本及匹配依赖/环境，其完整可用性未认证。旧 1920px/Card 密度与 Accordion 动画观察不由现有测试等价替代；未跟踪的旧截图、`f03-ui-handoff.md` 等外部材料仍为 UNKNOWN。

回退时用 `git show 7bdefe40c4eb0e9eab896d790b87e76edc7eaec1:<path>` 恢复上述两个 `scripts/` 路径的原字节，并仅移除本新增说明。不得把历史 FAIL/UNKNOWN 改记为当前 PASS。

本次退役验收仅检查静态调用、链接与归档字节；组件、HTTP、脚本、构建、桌面/390px 浏览器均 UNRUN。删除旧入口不替代或认证这些运行时覆盖。
