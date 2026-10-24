# 日志合并前回归修复与验证

固定代码提交 `0443dd1de3f7b1803df9a33da724870d0b21ad7e`，tree `487d7e95d550c6f2ae2aff1012016ba2ac70e2f9`，修复基线 `b8b47dd7603e41cef3ef9e4559d6c6e53f128193`。

最终完整运行：**4190 通过、0 失败、6 跳过，退出码 0，无 Vitest 未处理错误**。类型检查和最终生产模式构建通过。详细报告和原始失败证据保存在 `/tmp/implement-spec-180/merge-repair/`。

独立临时目录中的最终产物接口检查也退出 0：`/_openapi.json`、`/_scalar`、`/_swagger` 为 404，`/api/health`、`/api/jobs/kinds` 为 200。进程组已结束、端口可重新绑定、fixture 已删除；这是本地产物检查，不是生产部署。

## 修复范围

1. **运行数据被源码监听器读取。** installed Nuxt Icon 2.5.1 的 custom-collection `builder:watch` 会将变更文件读为 UTF-8。真实 fs 探针捕获了对约 178 MB `.runtime-logs/events.db` 的连续读取；服务日志中同时保留了约 4 GiB 堆耗尽。运行目录现按 Nuxt 根相对、Vite 项目根绝对路径排除，保留 `components/files` 和 `server/api/files` 的源码监听。没有提高应用堆上限。
2. **隔离测试服务清理。** `spawnOwnedChild` / `forkOwnedChild` 创建专属 POSIX 进程组；启动器先退出，普通 native 后代仍属于原组。停止只作用于已登记组，查询实际组成员确认回收，并核对 leader 开始时间。没有 PPID 定时采样，没有按端口、名称或工作区查杀。68 个消费者仅机械替换启动函数导入，其余参数、请求和原断言不变。
3. **UI 测试接线。** bare Vue 的任务详情补可选 Nuxt app 注入；来源导航按当前出处折叠区及按钮路径操作。原任务状态、请求身份、水合和导航断言保留。
4. **派生任务的测试生命周期。** 平台核查测试在删除 fixture 前等待真实 runner 空闲，确认无 queued/running 任务，关闭数据库；新增用例确认派生任务真实完成。没有清空队列来代替等待。
5. **测试引导与冷启动准备。** 普通 unit 显式启用 evlog、使用 quiet unit sink；不修改 console，不忽略未处理错误，不改变真实子 Nuxt 环境。日志测试仍自行安装真实 drain。双数据库身份场景把真实 HTTP/native 准备放入两个标准 fixture hook，用例自身默认 5 秒和生产 worker 启动 5 秒均不变；readiness 前提前完成会明确失败。UI 用例预算和业务代码没有修改。

应用改动仅涉及开发监听配置；其余为测试/本地验证启动器及接线。未修改业务 SQL、业务迁移、权限、日志采集策略、队列容量或生产超时。

## Requirement | Evidence

| Requirement | Evidence |
| --- | --- |
| 运行数据库不被当源码，同时真实组件/API 可更新 | `does not scan changing runtime databases as icon source while real API errors and logging remain available`：真实 Nuxt、fs 边界探针、API 400/health 200、新路由 JSON、组件读取及日志库存在 |
| 自有组回收且不影响旁边服务 | `stops native descendants after the launcher exits without stopping an unrelated service` |
| 启动器先退出仍回收 | `retains native ownership when the launcher exits before cleanup is called` |
| 无 readiness/采样窗口的 spawn/fork 后代 | `collects a descendant born just before spawn launcher exit without readiness sampling`；`collects a descendant born just before fork launcher exit without readiness sampling` |
| 默认 unit 不刷终端，真实日志测试仍可安装 drain | `keeps default unit diagnostics enabled and builds context without terminal output`；`allows a logging test to install its own real evlog drain and retain application metadata` |
| 派生任务不越过 fixture 生命周期 | `settles auto-enqueued derived jobs before fixture teardown`；两个文件每例额外断言无 queued/running 行 |
| 原业务读取与完整 native 清理保持 | `actual Nuxt preserves full summary differences and MCP evidence with canonical matches, legacy sources and acknowledged commits` |
| 原任务状态与来源导航保持 | `shows a checkpointed running event as unfinished when its task has been cancelled`；`reports retained candidates when a later source row fails within the same event`；`uses a summary list on the product route and opens the complete selected source after point hydration` |

完整命令：

```sh
TICKET_186_SKIP_BUILD=1 LOG180_SKIP_BUILD=1 pnpm exec vitest run \
  --maxWorkers=1 --reporter=default --reporter=json \
  --outputFile=/tmp/implement-spec-180/merge-repair/full-final-quiet.json
pnpm typecheck
pnpm build
```

跳过构建的测试复用本提交应用源码的已构建产物；没有跳过整个 HTTP 套件。最终 JSON 为 4196 项：4190 通过、6 跳过。6 项是原有真实文件条件/规模 opt-in 检查，本次没有新增 skip。所有权文件仅移动 fixture 准备，未提高用例超时。另有 29 文件 485 项扩展验证通过、33 个 mjs 语法检查通过。

## 审查与失败记录

- 静态 r1 的宽泛 `files` 排除问题已改为根限定；真实测试同时验证源码目录正向监听。
- 静态 r2 的进程树采样窗口已改为专属进程组；r3 为 P1/P2/P3 均 0。
- r4（派生任务收尾）与 r5（测试引导、fixture hook）均为 P1/P2/P3 0。r5 固定 tree 与最终代码 tree 一致。
- 最初完整运行 3938 通过 / 213 失败 / 36 未执行或跳过，原始记录不覆盖。
- 两次为处理审查而中断的完整运行保留为 ABORT，不计 PASS。
- 一轮 4187 断言通过 / 6 跳过，但有两个控制台 RPC teardown 未处理错误、退出 1；不能因 JSON `success:true` 当作通过。两个文件原源码窄跑同样复现，等待真实派生任务后干净退出。
- 后续一轮有 9 个默认 5000ms timeout；同源单独 49/49 又通过。机器负载快照不能单独证明其原因。quiet 后扩展仍出现 owner timeout，未宣称 quiet 独自解决所有超时；随后分离真实 fixture 准备。历史 timeout 的全部具体因果仍不作追认。
- runtime 排除反向控制、过宽源码排除、提前退出、无采样退出窗口、macOS 组探测 EPERM、类型推导错误及新增测试误用 API 的中间失败均保留。最终测试没有放宽业务断言、过滤失败或忽略未处理异常。

## 验收服务与边界

50055 曾因同样的堆耗尽退出，旧日志已保留。恢复时 health、日志页面、配置读取均 200，revision 0 → 0，现有合成业务主库 SHA-256 不变；未重置用户 fixture，未向其写配置。最终 health 再读为 200。

进程组 helper 面向 POSIX；主动自行脱离组的命令不在保证内，本轮未做 Windows/Linux 平台矩阵。没有重新认证生产部署、CI、完整应用 SLO 或真实业务快照性能；此报告不把测试框架修复当作应用性能无回归证明。既有性能/历史 UNKNOWN 证据保留。
