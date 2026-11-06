# 当前名录后台导出共享契约（#116 / #117）

> 本页保留共享提交、任务和产物接口说明；下文 v8 周期/适用性及 #409 执行年份段属于当时版本，不作为默认资格判定的最新规则。当前源码默认 ruleVersion 为 current-roster-116-v10、assessmentVersion 为 enterprise-qualification-478-v3；现行资格边界与交付限制见 [#478](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/478)。旧显式 v1/v2 兼容和旧任务版本继续保留，不能把新规则回写到旧回执。本文整理没有运行资格或导出验收。

#117 提供小巨人专用入口及共享服务；#118/#119 复用下列 kind、资格投影、工作簿和产物服务，不复制规则。集成版本已提供三个专用路由及 #120/#121 后台任务页面。

## HTTP

- `GET /api/roster/exports/current/capabilities`：公开只读、`Cache-Control: no-store`，仅返回 `{exports:[{titleCode,path,ready}]}`。路由清单取自本构建扫描到的实际专用 POST handlers，ready 同时要求共享 kind 已就绪；缺失路由不出现在清单。前端按固定称号与路径双重匹配，发现失败或缺项保持禁用，不能假设未部署入口存在。此接口不创建任务、不返回凭据、宿主路径或业务数据，生产 OpenAPI 仍默认关闭。

- `POST /api/roster/exports/current/little-giant`，JSON `{ "clientRequestId": "稳定请求标识", "regenerateOf": "可选的同称号已结束任务ID" }`。外部调用需 API token，同源页面按[任务中心契约](task-center.md)校验请求；返回 **202**、`Location: /api/jobs/{id}` 和 `{jobId,kind,state}`。

| 专用 POST 路径 | 固定 titleCode | 下载文件名 |
| --- | --- | --- |
| /api/roster/exports/current/little-giant | little_giant | current-little_giant.xlsx |
| /api/roster/exports/current/specialized-sme | specialized_sme | current-specialized_sme.xlsx |
| /api/roster/exports/current/innovative-sme | innovative_sme | current-innovative_sme.xlsx |

三个专用入口使用相同请求 schema、202/Location、共享 kind/队列、鉴权、持久去重、显式重新生成与产物边界；均拒绝请求体称号覆盖及任何查询参数。下载文件名按上表固定，其他共享说明见下文。

- 共用 `POST /api/jobs`：`{kind:"current-roster-export",params:{titleCode:"little_giant"|"specialized_sme"|"innovative_sme",clientRequestId,regenerateOf?}}`。后续专用路由固定称号并复用同一提交服务。两种提交均拒绝参数中的历史日期及其他未知字段。
- 复用 `GET /api/jobs/kinds`、`GET /api/jobs?kind=current-roster-export`、`GET /api/jobs/{id}`、`DELETE /api/jobs/{id}`。读历史沿用公开读接口；提交/取消沿用 `NUXT_API_TOKEN`（Bearer 或 X-API-Token）。未配置 token 时外部写入口关闭；同源页面通过称号专用入口提交、通过任务中心取消，默认可用。
- `GET /api/job-artifacts/{id}` 下载真实 xlsx，**每次检查同源页面请求或 API token**，知道 jobId 不能跳过鉴权。只接受 ULID，不接受磁盘路径。响应 MIME 为 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`；`Content-Disposition: attachment; filename="<上表对应文件名>"`；`ETag` 为 SHA-256；`Cache-Control: private, no-store`。
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

四张表固定为“有效企业”“待确认”“排除明细”“口径说明”。前三表列固定为：序号、企业名称、统一社会信用代码、区县、称号、首次认定年份、认定及复核情况、公布名称、已确认曾用名、公布对应情况、情况说明、来源及页码。所有身份/来源文本写成文本单元格。按稳定企业 ID 一称号一行，跨称号独立，无分页截断；空集仍包含表头及说明。说明给三组精确计数、规则、快照摘要、时间及当前识别范围，不声称全市完整。

共享入口为 `createCurrentQualificationAssessmentReader` 和 `writeCurrentWorkbook`。只读正式业务数据；任务状态和独立产物为允许的写入。

工作簿适配器使用精确版本 `documonster@0.20.2` 的公开 `Stream.WorkbookWriter` / `Stream.commitRow`，保留原有仅接收文件名的接口，由适配器创建并持有默认生命周期的 `fs.WriteStream`，关闭共享字符串、逐行编码。固定四张表按顺序完成，避免 ZIP 后续条目在前表结束前积累整表输出；首遍生成数据摘要与组计数，直接写有效企业，仅暂存待确认/排除组的稳定 ID（受现有单表行上限约束），随后在同一读取事务内重读这些 ID。不会收集完整单元格行、工作表 XML 或 ZIP，分组内仍按稳定 ID 排序。这个选择增加部分候选读取和 ID 空间成本，需保留同种子、同预算下的耗时/内存证据，不声称总内存恒定。每 100 个候选让出事件循环；进度仍只按首遍的每 100 个候选上报，延后写表不重复完成计数。写入触发背压时暂停生产，文件流的写入、提前关闭或最终提交错误均使执行失败。最终提交和文件流关闭后才返回，原有 `.part` 同步、原子发布及失败/取消清理仍由任务服务负责。此路径只写字符串或空单元格，不使用库的日期转换或公式缓存推断。

### 历史资格规则（v8）

以下周期、身份与适用性说明保留当时版本，不代表当前默认 v10 / assessment v3 的资格政策。

- 有正式出处的认定无需先有复核即可纳入。先按原认定 `(year,batch)` 收集**全部** award/review（含失败、缺结果及缺批次），逐周期裁定后，才按原年份选择当前候选；该原年份的全部批次继续保留，不按最新 passed/最大 seed 丢弃其他批次。每批明确结论一致时按一致结论纳入或排除，数量本身不是缺口；实际混合/未决列待确认。
- 完整正式 passed 可独立确证延续：原周期、批次、通过结果和结论年明确且不早于原年、未在未来，按结论年延续三年；即使存在另一周期旧认定，或只有连续/跨周期正式复核也适用。首次年份只取真实 award 历史，无 award 留空。同周期 failed 后仅出现 passed 不构成恢复认定，恢复矛盾列待确认；最终明确失败且未重新认定列排除。明确后续 award 或现存正式更正事实才可消除对应失败，不能用生命周期 active 标签或最大结论年伪造恢复。
- 已知旧周期失败不自动终止新周期，旧失败与当前周期 passed 恰同结论年亦不冲突。真实新 award 与旧失败同年且尚未被更晚真实 award 消解时，保留恢复先后不明，不能按 ID 猜顺序；已消解的历史同年疑点不永久阻断，当前周期已明确终止也不因旧恢复疑点降为待确认。旧周期晚通过不能遮蔽新周期失败；原周期未知的旧复核只有结论年明确早于后续真实新 award 时才让位，保留旧缺口、事件和出处。未知结论年、同年或未来均不猜；review 不是恢复 award。当前周期的日期、批次、结果/结论年缺口、同年冲突或应复核无结果列待确认；已知旧周期缺口不冒充当前周期。同周期较早未知结果可被较晚明确失败或真实新认定消解，但较晚 passed 不能消解潜在失败；同年、无日期或当前批次归属仍不清的缺口继续待确认。旧无出处 award 按原周期关联，不将其结论年拿来与独立延续的原年比较；非关键旧首次缺口留空、引用保留，不改变独立正式延续的确定资格。当时版本的完整判定表及公开回归见 [第四轮修复说明（历史证据）](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r4.md) 和 [第五轮修复说明（历史证据）](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r5.md)。
- 明确 failed 的结论年与未知 batch 归属分别保留：缺 batch 仍参与上述跨周期同年恢复检查，不能因只保留 gap 而丢失失败时间。旧周期失败晚于新 award 但不同年时继续遵循原周期隔离。未知 batch 的 award 分别检验可单独成批的资格，已知批次不借用它来恢复；各可行归属全部有效时纳入，一致确认事实不因 batch 缺失自动降级。到期、真实失败、未定序或未消解的复核归属仍影响判定，不把多个 null batch 猜成同一批。
- 复用 `computeTitleLifecycle` 的首次认定和三年锚点；它的 active 标签不独立证明当前有效。明确的对应周期失败且未恢复列排除；纯培育不构成资格。平台更新、申请退回/待审核、失败查询/零行/快照缺席不自动推翻正式资格。
- 采用 #102 六个称号×方向坐标的当前替代/撤回头；注销、外迁、迁回是同一稳定企业的主体事实，核实依据、生效时间、身份/查询范围后作用于全部称号，不能随称号复活。其他称号的资格解释、迁入称号限定和原始平台状态不传播；相关主体事实适用性不明或冲突时列待确认。主体存在与地理位置分开核实：当前头中仍有效的注销/终止独立导致排除，另一坐标上更晚或同日的迁入不视为主体恢复；明确撤回/替代注销后重判，适用性未确认则待确认。地理事实仅在迁出/迁入间比较生效时间，后续明确迁回可恢复宁波地理依据，同日迁出/迁入冲突待确认。历史导入决定、缺码已变化、身份/证据不一致或更正后适用性未知均保留引用，列待确认。
- 公布名称展示遵循已批准的[逐出处名称展示专项契约](official-published-presentation.md)（#355），只使用本称号逐出处事实，按事件年/批次、文件及原 locator 与来源列对应；无逐出处捕获的 legacy 显示“未逐出处核实”，不从 record.name_raw、现名或 alias 反推。现名不同的既有资格身份核验仍须有已确认别名或对应统代链；已确认曾用名列独立保留原 confirmed alias。迁入备注和原缺口保留，移除旧首名推断的“现已更名为”句，不据公布名推断合法更名。同名不同主体不合并。首次年份等非关键补充缺口留空，不能静默丢弃已确认当前资格。

### 历史解释适用性与迁入资格（v8）

#108 已交付。导出直接消费 `readQueryAssessment` 的 `explanationValidity`，只有 valid 的已确认主体事实可确定应用；evidence_changed、premise_invalid、unknown 保留引用并待确认。查询覆盖的 unknown/failed/partial 不转换成 no_record。legacy 决定经 maintain 明确复核后可用，缺失的依据/生效时点只从该决定的复核回执读取，不改旧版本。当前 replace/withdraw、跨称号主体事实及同日冲突仍按原边界处理。

既有 movedIn 只有城市、称号和批次，记录对应只证明来源关系，均不单独证明当前资格。现有 #102 决定写面新增可选 `decision.currentQualification`，只允许同称号 confirmed moved_in、通过 evidenceRelationId 引用已存在、归属已确认且经同主体/称号核验的正向平台关系证据。该字段是调用者独立核实资格后的明确断言，不是系统从单行平台状态推定：

```json
{"titleCode":"specialized_sme","validFrom":"2025-01-01T00:00:00Z","validUntil":"2028-01-01T00:00:00Z","basis":"具体外地正式认定/延续来源及核实依据","publicationCheck":{"status":"not_found","scope":"已入库并已核对的宁波该称号公布范围，含现名及确认旧名"}}
```

时间区间为左闭右开，必须非空。字段随决定版本保存到可空 JSON 列，REST 和 MCP 共用同一校验/乐观并发/幂等/审计路径；浏览器写面保持相同业务 schema。新决定需经 #108 明确复核建立 valid 基线；旧数据不自动补字段。字段不存在、过期、尚未生效、publicationCheck=not_checked 或证据已变化时待确认，不用 movedIn 年份/批次或维护行推算资格。当前主体已确认迁入时，消费仍有效的本称号断言；旧宁波历史不会阻断后获批的独立当前资格。无本地正式事件时，输出“迁入；未见宁波该称号公布记录（限已核对范围）”，附核对范围、决定/证据引用和确认曾用名；首次认定年份没有正式历史则留空。该路径不生成正式事件、不更改公布历史。

只有自由文本取消/撤销/终止、缺对应资格周期的结构化依据时仍待确认；本修复未新增自动终止判因。候选对应边仍不提升为资格。

### 历史存量身份及候选范围（v8）

正式事件通过稳定 enterprise_id 及正式出处归属主体；record.name_raw/uscc_raw 既有契约可空。有正式出处和稳定统代、无明确身份冲突的记录不因 raw 名空白单独降级；“公布名未留档”原缺口说明保留，公布名称展示按上述专项契约：legacy 逐出处标注“未逐出处核实”，已捕获但 nameRaw=null 标注“已捕获出处，名称原值未知”，不再以空单元格表示这两类未知。已捕获的空串/空白按 JSON 字符串保真，缺少本称号出处时不补现名。不将现名伪造成公布名，不回填业务数据；无稳定统代且公布身份无法核验、或显式名称/统代冲突仍待确认。已留存的公布名及确认旧名按原规则核验。

候选来自本称号记录、决定、对应边及正向平台关系行；只有 query_key 命中的查询尝试不入池，no_record/failed 本身不产生本称号候选。有关系行尚未分配企业时，精确统代可识别候选，但仍待资格核实。多称号 recognized 封套按 pages 的原始分段和 sequence_no 归属称号；不能定位时在封套声明称号范围保留待核，不按全封套将已明确的其他称号行混入。查询/关系原始大字段不进入 JS，元数据定位在 SQLite 内完成。三处 rdjb 转换共用 recognized-evidence 字典的反向边界。

### 引用读取边界（v3）

导出及反向引用的 `listRecordCorrespondenceRefs` 只返回窄引用与 `requiresRevalidation`，不为重新校验把归档 query、关系原字段或保存的 provenance 读进 JS。共享读能力在 SQLite 内逐字段比较已确认的来源快照与当前来源，包括原文/JSON、正式事件 revision、正式出处、文件删除/哈希、前置事件和当前企业身份；输出仅为窄引用和布尔结果。后续流程无前置事件时也复用完整读取的企业ID/统代身份规则；未分配企业的来源行不能绕过目标企业当前统代核验，已确认同主体分配与缺统代的许可边界保持一致。来源同长度修改也会失效，引用不据此提升为资格。

`recognized_export/same_current_row` 仍须复验当前有效的对应范围凭据。只选择同查询、同导出批次的 current_source_equivalence 凭据；official_coverage 及其他端点凭据不证明本边现状等价，不为其读取正式档案。现有凭据服务需要全来源摘要，因此反向引用在调用前按实际读取字节检查 64 KiB 预算，包含端点、每条相关凭据的查询/全部关系行、批次/全部导出行、冻结文件和全部凭据审计；重复凭据造成的重复来源读取重复计量。超过预算明确 `requiresRevalidation:true`，不把未检查的大归档说成仍有效。超预算表示本次窄读尚未完成复验，引用说明为“来源需重新核实”，不声称来源已经变化。完整读取及写入同样只核验能证明当前两端等价的相关凭据；正式覆盖仍由正式范围服务独立处理。该保守边界不修改持久决定或凭据。任务摘要继续显示历史 v1/v2/v3/v4 的原规则版本，不将旧产物标成 v5。历史证据与资源复验见 [第二轮修复说明（历史证据）](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r2.md)。


历史 v8 补充：绑定 enterpriseId 不能忽略明确矛盾的原始统代；新写入拒绝，旧决定保留原审计并在导出中待核。身份、主体适用性及本称号解释的未决缺口在迁入求值后仍阻塞，不用原因自由文本自动判定终止。其他称号的资格解释不传播到本称号，主体事实仍跨称号。

有旧正式历史时，独立当前资格区间必须严格晚于已知旧周期及事实年份；现有失败、未知复核结论/批次不能只凭区间起点消解。可选 `currentQualification.awardYear` 明确记录经独立核实的真实新授予年份（不能由区间、平台状态或说明文字推定），且不得晚于有效区间起点年份；只有严格晚于旧周期和所有事实时才恢复。较晚失败、同年顺序或缺时间仍待核。保留旧 event/evidence、首次年份、公布身份说明和新决定资格依据/核对范围；不向正式事件表补造事件。没有本地正式历史时首次年份仍留空。

未归属关系候选及引用统一使用 normalizeUscc（空白消除、转大写），只识别候选，不自动确认关系或资格。导出固定读事务内一次遍历现有身份键索引收集非规范变体，各企业复用索引取全局最新51个查询ID后才投影元数据，保留50条加truncated契约；不读归档原始大字段、不持久缓存、不截断候选。


### #409 共享评估消费与内部来源上下文

三组直接读取完整三称号 T2 的所选称号 assessment.group，保留原行非枚举工作簿事实与逐出处独立复验；不复制资格策略。全称号候选按稳定ID有界keyset读取，先排空语句再以共享readTitle计数；只在所属sheet为每主体一次进入完整评估，严格校验扫描组与完整T2组一致。相同有序完整出处scope与正式显示scope在同次默认T2读取内复用已验证raw facts或typed error；不同scope保留独立显示复验，不缩减完整T2来源或复用查询最终展示预算。待确认不受查询页面的非空搜索定位限制；三个业务表与12列文本/空语义不变。

以下执行年份与摘要帧描述保留 #409 当时版本，不作为当前默认规则的年份说明；旧回执及产物不回写：

每次执行使用一个 generatedAt/asOf、UTC年份及一个只读SQLite快照。dataVersion仍是opaque的sha256:摘要；新算法逐帧JSON后加换行：首帧[current-export-assessment-409-v2,assessmentVersion,ruleVersion,UTCyear,title]，随后依有效/待确认/排除的固定sheet顺序、每sheet稳定ID顺序逐帧[group,id,完整三称号scope,完整T2 snapshotId,实际12列文本/空投影]。scope含enterpriseId/asOf/ruleVersion/assessmentVersion；各组序号取该组稳定ID顺序。企业T2摘要不同于job.snapshotId（仍为jobID）。历史产物/摘要不重写，不要求两次实时执行摘要相等。

执行时父进程仅捕获runtime apiToken/mcpToken/ocrToken，以私有启动IPC传递不可变窄context；不进入公开输入、任务持久化、日志或响应。worker在相同只读快照内自行resolve saved/env：saved优先，OCR仅无saved时runtime.trim优先于env NUXT_OCR_TOKEN/PADDLE fallback。未选中的runtime OCR不额外脱敏；原additionalSecrets、runtime API/MCP、env API/MCP、已选cookie/OCR的union顺序和默认省略路径保留。显式空context不回退child runtime。新transport单字段16KiB、三字段合计48KiB、JSON64KiB，非法/超限安全失败不截断；既有source/response/page/workbook预算不变。

完整阶段交付与规则演进原文：[current-roster-export-118](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-export-118.md)、[current-roster-export-119](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-export-119.md)、[current-roster-review-fixes-r1](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r1.md)、[current-roster-review-fixes-r2](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r2.md)、[current-roster-review-fixes-r3](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r3.md)、[current-roster-review-fixes-r4](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r4.md)、[current-roster-review-fixes-r5](https://github.com/MangMax/ningbo-specialized-sme-platform/blob/bee8366d1847ad425cb408990fb5127f0dc73ede/docs/current-roster-review-fixes-r5.md)。各文档的旧失败、未决、原始基线、测试矩阵及未运行边界保留在固定 Git 版本；其中 /tmp 日志及其他外部材料的当前存续未经本次核实，固定文档可恢复不表示那些外部材料已归档。
