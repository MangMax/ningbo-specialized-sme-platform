# 按已保存分段补齐正式事件（#671 / #667）

文件管理的独立「同步到企业」抽屉消费 #669 声明，不保存描述或范围。
`FileEventSync.vue` 与 #668 的 `EditSegmentsDialog.vue` 各自拥有状态、请求和保存流程；
共同修改仅限 `pages/files.vue` 的导入及相邻入口，合入 #668 时保留两者。
不增加表或迁移，不修改范围 writer、企业模型或资格规则。

## 公共契约

- `POST /api/files/{id}/event-sync/preflight`：需现有 API token，严格请求
  `{idempotencyKey, actor:{type:"user"|"agent",id}, basis}`。
- `POST /api/files/{id}/event-sync/commit`：需同样鉴权，严格请求
  `{request:原请求,planHash:64位小写SHA256,chunk:0起块号}`。
- `browser-preflight` / `browser-commit` 是同目录的同源页面适配器：请求中不允许 actor；
  复用既有显式 browserReviewEnabled + 已配置写能力 + 精确 Origin/JSON gate，
  服务端 actor 为 `agent/same-origin-file-event-sync-adapter`，不表示真实登录人。
  浏览器既不接收也不提交任务 token，现有代理鉴权不放宽。
- `idempotencyKey` 1–120 字符、basis 1–4000、actor ID 1–200；封套最多16KiB。
  输入值 trim 后绑定。客户端改依据须换新键，响应未知则保留原键原载荷重试。

预检返回 `planHash,rows,chunks,chunkSize,completed,counts`；rows 包含事件稳定 ID、
企业 ID/名称、前后 year/batchSeq、update/unchanged/conflict 状态及具体原因。
前后值是计划值，不是提交后的再次读取。页面逐50行分页展示，容量内无截断。

每文件至多3000出处、1000声明（含撤回历史），单事件300出处/300对应影响、
3000历史行/同记录事件，超限413拒绝，不生成截断计划。每块100个事件，最多30块，
必须顺序提交；一次页面确认顺序执行全部块。每块事务内复用正式更正预检、修订推进、
审计、派生段刷新及对应需重核语义。SQLite 的 immediate 外层事务包住整块，
任一失败回滚该块；已完成块保留。无需等待块间锁，也不假称跨块整体原子。

同键同请求返回已有计划进度；每个完成块保存自己的不可变回执，后续块执行后重放前块
仍回原回执，磁盘变化也不重记审计。失败块仅在回滚后记录进度信息，failed 与 unexecuted
分开统计；重试成功清除该失败条数。网络响应不确定时先原样重试，不把未知响应当失败记账。
页面关闭保留当前组件内的原请求；刷新页面可发新预检，仅尚未知的字段成为新更新项。
公共调用者可保存原请求/hash/块号续跑。

## 选择与重验

只按当前文件、活动稳定声明的 title/event/attachment、明确物理页闭区间匹配已有正式出处。
附件沿用统一归一；同页同附件多个声明一律歧义，绝不选最窄范围或按顺序猜。
未知页、无对应声明、过期 SHA/物理 epoch、已知不同年月、自然键占用、原认定约束
分别待核。段值未知不补。仅补未知 year/batchSeq，不写 decidedYear、reviewOutcome、
formalValidity、statementPages、企业资料或出处原始公布值。

同文件多出处必须各自唯一对应且分段年月一致。跨文件多出处当前保守列为
「多出处未能证明一致，须逐出处核实」：没有假称所有多来源场景均可自动闭合。
Office/不可读 PDF 无可靠物理页数时明确拒绝定位，不伪造全文件范围。

计划 hash 绑定完整原始 fingerprint、请求、全部行及操作；原 fingerprint 保留，
另有执行进度 expectedFingerprint。提交在事务内重新扫描当前文件完整候选集合，包括
被跳过的事件、所有出处及公布原值历史、同记录事件、对应与原认定影响、全部声明和
文件身份。新增/移除/变化令旧计划409失效。只在本块自己的原子更正后推进预期指纹，
因此下一块允许本次已完成的更正，不吞掉外部变化。完整候选成员不是原目标 ID 列表。

真实 PDFium 验页与文件 SHA/epoch 检查沿用 #669 只读接缝；该检查不提供外部文件写入者的
跨进程锁，最后检查后的外部替换仍属于既有 #311 边界。没有把当前源冒充历史解析来源。

同步后的资格及缺口由既有读模型解释。年月缺口可消除；结论年、复核结果、公布名未留档、
明确有效期或原认定绑定等其他缺口不自动消除。仍须读取名单、详情和下载工作簿核对。
