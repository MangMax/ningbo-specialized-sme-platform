# 当前名录后台导出共享契约（#116 / #117）

规则版本：`current-roster-116-v1`。#117 提供小巨人专用入口及共享服务；#118/#119 复用下列 kind、资格投影、工作簿和产物服务，不复制规则。此片不实现另两条专用路由，也不实现 #120/#121 页面。

## HTTP

- `POST /api/roster/exports/current/little-giant`，JSON `{ "clientRequestId": "稳定请求标识", "regenerateOf": "可选的同称号已结束任务ID" }`。需 API token，返回 **202**、`Location: /api/jobs/{id}` 和 `{jobId,kind,state}`。
- 共用 `POST /api/jobs`：`{kind:"current-roster-export",params:{titleCode:"little_giant"|"specialized_sme"|"innovative_sme",clientRequestId,regenerateOf?}}`。后续专用路由固定称号并复用同一提交服务。两种提交均拒绝参数中的历史日期及其他未知字段。
- 复用 `GET /api/jobs/kinds`、`GET /api/jobs?kind=current-roster-export`、`GET /api/jobs/{id}`、`DELETE /api/jobs/{id}`。读历史沿用公开读接口；提交/取消沿用 `NUXT_API_TOKEN`（Bearer 或 X-API-Token）。未配置 token 时写入口关闭。
- `GET /api/job-artifacts/{id}` 下载真实 xlsx，**每次检查同一 API token**，知道 jobId 不能跳过鉴权。只接受 ULID，不接受磁盘路径。响应 MIME 为 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`；`Content-Disposition: attachment; filename="current-little_giant.xlsx"`；`ETag` 为 SHA-256；`Cache-Control: private, no-store`。
- 参数错误 400，未授权 401，同请求标识用于不同参数或重新生成目标非法 409，容量满 429。没有成功发布/缺失文件 404，过期 410。

同 kind 的 `clientRequestId` 持久去重（含终态）；更改称号或 regenerateOf 要换新标识，否则 409。重新生成使用新标识并关联同称号的已结束任务。去重检查先于容量检查；不会自动重试失败任务。

## 状态、版本和产物

沿用 queued → running → done / failed / cancelled。未知总数的 queued/starting 阶段 `percent:null`，有真实候选总数后按处理行数报告；`result.phase` 为 starting / workbook / complete。进度不代表已发布文件。

执行进程在一个 SQLite 只读事务内固定快照。`snapshotId` 唯一标识该执行快照，`snapshotStartedAt` 记录固定快照边界，`ruleVersion` 在执行时即记录；最终 `dataVersion:sha256:...` 为该规则、年度及实际读取投影内容的摘要。排队期间不声称已经读取名单，生成时间不代表实时核查。

成功 `result`：`phase, snapshotId, snapshotStartedAt, generatedAt, ruleVersion, dataVersion, counts:{eligible,pending,excluded}, total, executor` 和 `artifact`。`executor` 提供该独立执行进程的峰值 RSS、堆上限和完成时堆使用量（用于资源验收）。

`artifact`：`id,downloadUrl,filename,size,sha256,generatedAt,expiresAt,availability`；availability 为 available / expired / missing，每次详情、列表和下载重新核对。无宿主绝对路径。历史任务 done 与当前产物可用性分开：过期/缺失不篡改历史成功事实。

产物目录为部署 SQLite 文件名加 `.exports`，独立于上传/正式出处库；需与 SQLite 一同放在持久卷。先写同目录 `.part`，完成、校验、同步后原子 rename 为 `.xlsx`，再将任务标 done。保留 **7 天（从发布算起）**；访问到期产物、首次任务库使用、后续导出开始时清理到期文件和无主/失败临时文件，历史保留。清理仅识别此目录中的受控 ID 文件，不删运行任务或其他已完成未过期文件。

进程重启沿用既有策略：queued/running 诚实标 failed，要求显式重新提交；不自动续跑。完成历史和文件保留。取消沿用排队立即取消、运行检查点尽力停止；导出进程可安全终止（它只读正式数据，唯一写入是自己的未发布文件），失败/取消清理未发布文件。

## 执行预算

复用现有单进程 FIFO 调度与 OCR 并发语义；导出执行占一个已有独占槽，**每次在独立 OS 子进程**读取 SQLite 和流式生成 Excel。执行 V8 堆约 304 MiB（256 MiB old + 3×16 MiB semi），10 分钟执行预算。导出运行/排队合计最多 9 个，超过返回 429；不为每种称号创建队列。普通 HTTP 主进程不执行全量资格遍历或工作簿 CPU 计算。单表数据超过1,048,575行、单元格超过32,767字符时明确失败并清理，不截断交付。

多实例共享同一库的分布式调度不在现有 runner 契约内；部署仍需单个任务运行实例。不会把单机测试当作生产性能承诺。

## 工作簿与资格

四张表固定为“有效企业”“待确认”“排除明细”“口径说明”。前三表列固定为：序号、稳定企业标识、统一社会信用代码、现名、公布名、已确认曾用名、宁波区县、称号、首次认定、最近授予/延续资格依据、复核情况、公布对应情况、备注、可核对依据。所有身份/来源文本写成文本单元格。按稳定企业 ID 一称号一行，跨称号独立，无分页截断；空集仍包含表头及说明。说明给三组精确计数、规则、快照摘要、时间及当前识别范围，不声称全市完整。

共享入口为 `readCurrentCandidate` 和 `writeCurrentWorkbook`。只读正式业务数据；任务状态和独立产物为允许的写入。

- 有正式出处的认定无需先有复核即可纳入；复核按原认定年/批次对应，结论年用于延续三年。旧周期失败不自动终止新周期，失败后新认定保留首次历史。应复核无结果、结果/周期/年份缺失或同年顺序冲突列待确认。
- 复用 `computeTitleLifecycle` 的首次认定和三年锚点；它的 active 标签不独立证明当前有效。明确的对应周期失败且未恢复列排除；纯培育不构成资格。平台更新、申请退回/待审核、失败查询/零行/快照缺席不自动推翻正式资格。
- 采用 #102 当前替代/撤回链及同称号范围的明确主体事实；已确认外迁/注销排除，后续明确迁回重新判断。历史导入决定、缺码已变化、身份/证据不一致或更正后适用性未知均保留引用，列待确认。
- 公布名称只使用本称号出处；现名不同须有已确认别名或对应统代链。迁入与更名备注累加；同名不同主体不合并。首次年份等非关键补充缺口留空，不能静默丢弃已确认当前资格。

### 明确的依赖边界

#108 的解释适用性/影响检查尚未在此基线交付；此实现不引入其未合入代码。下列坐标明确待确认，而非自动造事实：

1. 只有迁入决定/外部平台记录，缺已确认本称号当前资格和宁波公布核对范围。现有 movedIn 年份等元数据不单独证明资格，也不能确定声称“未见宁波公布”。
2. 只有自由文本“取消/撤销/终止”的决定，缺对应资格周期的结构化终止/恢复依据。
3. 历史解释适用性、来源更正后的前提或未确认对应边不足以确认当前资格/身份。

这些缺口在“待确认”保留企业、具体原因和旧决定/证据引用；不建设 #108 自动影响检查，不把候选边或原始平台状态升级为确认。没有把生产数据导入或生产业务结论包含在验收中。
