# 后台任务接入与通知

## 新增任务

以线索名单 CSV 导出为例，业务模块声明“导出名单版本”，平台负责登记、领取、记录进度和终态。列表里的名称和分组来自[模块清单](../../layers/lead-lists/manifest.ts)，名单版本的读取、内容生成及下载权限由[导出实现](../../layers/lead-lists/server/utils/export-job.ts)和业务路由负责。

1. 在模块清单的 `jobKinds` 登记全局唯一且稳定的 `kind`、业务人员看到的 `label`、`group` 和服务端导出名 `spec`。若总数要到某个阶段才有意义，可声明 `progressPhase`。修改显示名称时保留原 kind，历史任务按原标识可查。
2. 从 [core 服务端公共入口](../../layers/core/server/public.ts) 引入 `JobSpec`、`PostgresJobSpec` 类型。在所属模块导出同名 spec，加入[应用装配](../../server/install-application.ts)使用的该模块 spec 集合。用 `parse` 在提交时校验参数，用 `postgres.run` 执行任务。仍对 SQLite 开放的任务同时提供相应 handler。`GET /api/jobs/kinds` 可查当前运行模式实际开放的能力。
3. 通用提交接口是 `POST /api/jobs`。有业务准入条件时由业务路由校验后提交，返回 `202`、`jobId` 和指向任务的 `Location`。业务变更与任务必须同时生效时，在同一个 PostgreSQL 事务内调用 `stagePostgresJob(tx, input)`。确需重复请求去重的任务声明 `deduplicateRequest`，一次用户操作重试时沿用同一个 `clientRequestId`。
4. handler 使用传入的 `ctx`。按有业务意义的完成单位上报进度，PostgreSQL 下等待 `ctx.progress(done, total)` 完成；长批次在工作单元之间检查 `await ctx.cancelled()`。若需要中断后保留部分成果，用 `ctx.checkpoint(result, tx)` 与对应业务写入一起提交。返回 `{ result }`，部分失败或取消时保留已完成部分。运行中断后的安全重试条件由任务所属模块判断。

## 可以展示哪些业务信息

| 位置 | 接入约定 |
| --- | --- |
| 任务记录 | `params` 存执行所需的非敏感参数，如名单版本 ID。`result` 可含行数、阶段、业务对象 ID、下载回执或恢复用的检查点。原始文件、完整数据集、大型报表保存在所属模块的文件库或业务表。凭据在执行时获取。 |
| 任务中心 | 默认展示模块、名称、状态、进度和时间。需要补充信息时，由任务的 `postgres.taskCenter.summaries` 按当前页的任务 ID 批量投影出明确允许展示的字段，例如导出的行数、下载入口。详情按需读取，下载、重试和取消仍由服务端按本次请求校验。 |
| 实时通知 | 信号只表示任务数据已变化。用户可读的业务信息从现有 REST 接口按权限取得；事件中不放参数、结果、企业名称、异常正文或凭据。 |

## SSE 契约

业务页面使用 [useTaskSnapshot](../../layers/core/app/composables/useTaskSnapshot.ts)，传入查询条件和读取函数。同一页面的列表、详情和业务面板共用一条 `GET /api/task-center/events` 连接。收到 `ready` 时读取当前快照，收到 `changed` 时合并刷新。首连、断线重连和漏过多次变化都可以用一次快照恢复。任务中心读取 `/api/task-center` 或 `/api/task-center/{id}`，业务页面也可按原契约读取自己的结果。取消和重试沿用现有 HTTP 命令。

PostgreSQL 在事务提交后向应用的共享监听连接发信号，回滚不产生通知。一次事务可以合并多个变化，客户端按最新状态渲染。SQLite 兼容模式返回 HTTP 204，页面继续定时读取；PostgreSQL 的事件流不可用期间也保留刷新能力。已有 PostgreSQL 任务库先用 psql 执行可重复运行的 [install-job-runtime.sql](../../upgrade/postgresql/install-job-runtime.sql)，再上线应用。代理转发本路由时须支持流式响应并关闭响应缓冲。

## 验收

通过真实提交入口验证受理、执行、进度和终态，并按任务实际支持的能力覆盖取消、幂等重试和下载。对有业务副作用的任务，验明提交失败时任务与业务数据一同回滚。对展示在任务中心的业务字段，以实际用户权限分别验证可见字段和可执行操作。业务接入复用平台的通知通道，无需在 handler 中发送页面事件。
