# 公布事件归档候选任务（#214）

`POST /api/roster/correspondences/tasks` 返回 202 和 `jobId`。沿用 API token；同源任务页沿用任务中心浏览器来源检查，不接收浏览器凭据或自由输入操作人。后台行为记录为 agent / candidate-discovery-job，不冒充真实用户。

请求必须有 `clientRequestId`，范围恰选一种：`eventIds`（1–200 个正式事件）、`titleCode`（little_giant/specialized_sme/innovative_sme）或 `queryId`（已归档查询）。可用 `afterEventId` / `throughEventId` 指定有界续片。首次执行冻结最高事件 ID 和最多200个匹配事件，逐页25条候选，单行事务串行提交，逐行让出事件循环。称号范围需显式继续下一片；归档影响范围超过200条时以相同任务类型继续，回执保留后续任务入口。事件与候选页检查点使用既有 job.result，不新增表或迁移。

任务中心 `/tasks?tab=platform&job=…` 显示范围、成功/待核/失败、候选新增/保留数量、规则版本和逐事件入口。任务完成只说明生成工作完成，不能作为确认对应。事件入口继续使用现有公布出处、平台原行和关系读回。`GET /api/task-center/:id` 与 `GET /api/jobs/:id` 提供摘要/原检查点；任务中心的 cancel/retry 复用现有控制。最多10次执行；重启把中断任务标失败，显式重试保留已完成事件和页内行位置。规则变化需新任务，不重放旧版本检查点。

MCP 使用 `submit_event_archive_candidate_task` / `get_event_archive_candidate_task` / `retry_event_archive_candidate_task` / `cancel_event_archive_candidate_task`，调用与 REST 相同应用服务和任务队列。提交、取消、重试受现有 MCP token 门禁保护，读取可匿名。

归档导入仍经既有领域事务。独立导入进程只在归档事务中写入一个按 queryId+末条原行ID+规则版本去重的 queued job；应用进程收到导入回执后接管同一任务队列。原进程中断不会丢失已提交的任务记录；启动对账后通过任务中心显式恢复。导入幂等回放补回同一任务入口，不另造候选账本，也不在归档事务里执行发现工作。

候选复用 `discoverEventArchives` 的 event-archive-212-v1 规则。持久化只调用现有 preflight/commit，保存原始来源指纹、出处和追加审计。每行提交前，在同一 immediate 事务内再次检查该事件/原行的所有已有角色；candidate/confirmed/rejected/unlinked 和更正历史一律保留，不以新规则静默重新推荐。发现后发生的身份、来源、版本变化仍由领域预检/提交拒绝并报告失败。

资源边界：队列沿用非 OCR 任务独占规则，不新增并行执行通道；每任务最多200个事件检查点。增量影响筛选与单事件发现直接共用 USCC 的 SQL 归一化规则。

尚未解决的阻塞（#214 / PR #218 F1）：现有共享领域预检/提交会水合完整 query/relation，对完整 provenance 执行 JSON.stringify 后计算来源指纹，并把完整快照写入对应关系和追加审计。任务目前在进入该路径前用 SQLite 计算 query.raw_response + collection_evidence + relation.raw_fields 字节数，超过1 MiB 报 source_materialization_limit；这会永久阻塞已被导入接受的有效来源，重试不能解决，并非批准的输入范围限制。修复需要共享领域的有界来源序列化/指纹及快照写入接缝，保持现有指纹和审计兼容；现有分块原始证据读取接口与只读反向关联校验不能替代该接缝。不得靠放宽阈值、裁剪原档或绕过预检/提交处理。此原行未写入时，同事件此前已完成的候选仍保留；任务中心同时显示新增数和失败，不能声称整个事件未写入或任务已完成。

部分失败逐事件记录安全错误码；任意异常原文和凭据不进入任务中心摘要。生产回填需另行授权，本票仅在独立备份副本与合成边界上验证。
