# 通过应用查证平台

采集入库后按用户选择刷新企业差异，再执行[代理判断](difference-investigation.md#默认待核代理判断与覆盖写回)；仅采集任务交接影响清单，查询事实不自动改变业务原因。

1. 查看 `GET /api/platform/capabilities` 或 MCP `get_platform_capabilities`，再查看当前 OpenAPI / `tools/list` 的结构和鉴权。生产未明确开启时隐藏 OpenAPI，应使用 MCP 发现。
2. 按[负载编排](orchestration.md)把企业 ID/已确认代码分配给唯一负责人，跨文件复用。调查者数量与平台请求额度分开控制：所有工作者共用应用的平台请求上限，不各建请求池。
3. 按来源要求设置应用查询条件，保留全部原行、候选、称号/页码、实际条件、`queriedAt`、`completedAt`。公开企业/登记资料的身份查证可独立推进。
4. 对每个必需范围同时检查状态、完整性和未完成位置。失败、会话过期、页缺失、未查询不能当零记录。
5. 候选身份经审阅后，再进行独立应用预检/写入。查询不自动入库、合并、更名、补码或生成称号事件；即使身份未确认也保留全部正式行。

平台凭据由服务端管理，不属于此流程可读取内容。调查代理不读/展示 Cookie、不查看凭据存储、不直调平台网址。会话过期由运维在服务端维护，再由代理明确重试未完成项。应用任务令牌只授权提交/重试，不含平台会话数据。

## 选择来源

| source 原值 | 含义与条件 | 称号范围 |
|---|---|---|
| queryList | 申报记录；`name` 和/或 `uscc`，同时传入为 AND。 | 来源默认范围，不明确传 rdjb。 |
| businessList | 关联记录；必须传 `uscc`，不接受名称或认定列表专用筛选。 | 必传字符串 `rdjb:"all"` 或 `"1"`、`"2"`、`"3"`；all 从第1页开始。 |
| queryBusList | 已认定企业列表；`name` 和/或 `uscc`，同时传入为 AND。 | 默认 `rdjb:["1","2","3"]`；须非空、去重数组，不能用 businessList 的字符串形式。 |

称号级别：1＝创新型中小企业，2＝专精特新中小企业，3＝小巨人。三类来源均须保留同代码多关系；名称/关键词命中只算候选。

仅 queryBusList 接受以下可选限制：`sqsj` 为按先后排列的真实日期区间 `YYYY/MM/DD - YYYY/MM/DD`（边界是否包含及其时区未验证）；`rddqrq` 为有效年份 YYYY；`whpcyear` 为维护年 YYYY；`whpc` 为字符串1–15，且必须同时有 whpcyear；`szq` 为当前账号范围内的八位筛选码，与返回行的 szq 不同。排序只支持成对的 `orderField:"qymc",orderDirection:"asc"|"desc"`。默认不加这些限制，也不推断全平台通用地区字典。

## 单条与批量

单条：把查询对象提交至 `POST /api/platform/query` 或 MCP `query_platform`。响应含来源、`effectiveConditions`、`titleScope`、行、各页结果、`fetchedCount`、可为 null 的 `declaredTotal`、`completeness`、`fullRange`、`unfinished`。无记录要求全部所需范围完整且零行；`fullRange=false` 只证明请求的续查区间，总量未知保持 null。

批量：向 `POST /api/platform/batches` 提交 `{items:[{query:…},…],limits?:…}`，或用 MCP `submit_platform_batch`。提交/重试须有应用 API/MCP 任务令牌。保留回执 batchId、所有 itemId 和负责人。通过 `GET /api/platform/batches/{batchId}` / `get_platform_batch` 查进度，通过 `GET /api/platform/batches/{batchId}/items/{itemId}` / `get_platform_batch_item` 取单项结果。queued/running 表示未结束；`progress.done` 统计完整完成项，不是尝试项。最终 failed 仍可能包含成功项及分页检查点。

每项含只追加的查询 `segments` 和当前 `unfinished`。保留全部分段、原始时间、成功页及其行；按成功页 fetchedCount 对应返回行区间，不按名称/代码压缩。重试后当前项可完整，同时仍保留先前失败页历史。

## 只重试缺口

检查失败后，以 `{itemIds:[unfinishedItemId,…]}` 调用 `POST /api/platform/batches/{batchId}/retry`，或向 MCP `retry_platform_batch` 传 batchId、itemIds。ID 不变；已完成、未知项或正在运行的批次会被拒绝。只查未完成称号/页位置，原条件和页大小固定；已完成行及查询时间保留。

鉴权失败不自动重试。每次明确重试重新取得服务端提交时的凭据快照；配置变更不改变执行中的尝试。服务重启将 queued/running 作业标 failed、保留检查点，并要求明确重试，不能假称自动恢复。

单查手工续查使用返回的页大小和每个未完成位置：`startPage=page`；businessList 传字符串 `rdjb=position.rdjb`，queryBusList 传数组 `rdjb=[position.rdjb]`。部分称号完成时不重查全部。businessList 普通失败继续其他称号，鉴权/安全限制则停止；queryBusList 遇失败停止并保留尚未查询称号。批量首次执行沿用同一策略。

## 上限与证据

批量最多50项、10次尝试；单次批量执行最多200请求/120秒，逐项仍受单查100请求/60秒约束。保留行最多5000、结果最多8MiB（默认2MiB）。达到上限须标部分完成并列缺口，不能判无记录。队列等待时间不计入执行时间。重试不能扩充保留行/结果上限；放不下时另建明确范围查询，并保留旧证据。

所有平台请求在同一应用进程共享最多并发2个，包括单查、旧入口和退避。工作代理不各建直连请求池；此内存限流器不提供多实例协调。

存储支持 `business_list`、`apply_list` 和独立 `recognized_list`（仅 queryBusList）。用 `recognizedResultToImport` 将每个完整原结果/每个批量分段转换后，经统一预检/提交转存，保留原时间、条件、分页和原始行。元数据或结束证明不足继续待处理，不改标来源、不编完整性。通过 `GET /api/platform/queries` 或 `list_platform_queries` 读回历史，核对每个查询/行 ID。

归档后另查本地业务状态：`GET /api/platform/business-processes` / `list_platform_business_processes` 只读 `business_list` 办理记录，`view=records` 与 `view=isolated` 分别核对业务及无法并入的观察。用 `GET /api/platform/business-processes/{recordId}` / `get_platform_business_process` 读实际版本/观察，保留全部版本/观察计数、冲突和 `counts.*Truncated`；详情版本最多100、观察最多200，截断不能当完整。这里不提供 queryList/queryBusList 同等 typed 业务搜索。查询归档成功（collected）、业务记录/版本实际可读与尚未完成的迁移分别报告，不用查询/行 ID 或 kind 汇总冒充 migrated。

转存详见[归档转存契约](../../../../lib/platform/recognized-evidence.ts)；公开补充及 `cross_source` 当前条件见[身份查证](./uscc-recovery.md)。无凭据示例和行为校验见[示例说明](../examples/README.md)；完整 API 见[批量查询文档](../../../../server/api/platform/batches/index.post.ts)。

三接口业务采集任务使用 `difference_snapshot`，先备份，再按原编号入库全部业务字段；无需保留请求或响应原文。可选 `enterpriseIds` 测试少量公布企业。

下述 `rawDataVersion:1` 是其他调用方显式保留原文的兼容协议，不是新采集任务的存储要求。需要保留原 JSON 时，单查对象或批量 `items[].query` 显式加 `rawDataVersion:1`；先确认 capabilities v3 / tools/list 支持。原样保留 `rawData.version=1`、typed rows、实际接受页正文与页位置；旧 `rows` 只是字符串投影，缺少 rawData 的历史类型保持未知，不互相回退。原文敏感或超预算时，保留失败/unfinished 后补查，不裁剪正文。

封套归档可继续用 `recognizedResultToImport`。`collectionEvidence.rawData.version=1` 已显式选择 typed `rawData.rows` 作为 `relations[].rawFields` 与业务内容版本输入（#327）；封套版本、页/行、来源、解析、投影或关系冲突整批拒绝，不回退字符串行。无 rawData 的旧载荷仍按其原契约接受，历史类型未知，旧 ID/hash/raw/观察/决定不重算，不同接口业务身份独立。此接缝不代表 #298 或整条技能验收完成。原型同名键的现存 HTTP 拒绝边界及 MCP 读回能力见[归档接缝](../../../../lib/platform/recognized-evidence.ts)。

业务采集任务会复用同一查询范围内内容完全相同的最新完整结果，仅更新最近采集时间，不增加重复观察。任务仍实际请求供应商；失败和续页不按完整重复结果复用。三张业务表展示内容版本和采集时间，历史来源引用继续由原公开接口读取。
