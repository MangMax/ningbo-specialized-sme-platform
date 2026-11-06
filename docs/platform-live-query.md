# 平台实时只读查询（#51/#52/#53，共享契约 v1）

`POST /api/platform/query` 与 MCP `query_platform` 使用同一服务。入口不要求本库存在企业，不创建企业、别名、事件、证据、任务或快照。历史读取 `GET /api/platform/queries` 与 reconcile 保持原有接口和语义。

能力发现：`GET /api/platform/capabilities` / MCP `get_platform_capabilities`；开发环境 OpenAPI `/_openapi.json`，生产默认继续关闭。沿用应用只读入口无 token、写入/任务另行鉴权的既有策略。持有服务端平台会话不会取得应用写入权限。

## 来源与参数

已启用 `source: "queryList"`（申报记录，原适配来源 `apply_list`）和 `businessList`（关联记录）。`queryBusList`（已认定企业列表）亦已启用；各来源不能互相替代。

`businessList` **只支持 USCC**，必须显式提供 `rdjb:"1"`（创新型中小企业）、`"2"`（专精特新中小企业）、`"3"`（小巨人）或 `"all"`（依次全查三称号）。拒绝 `name`、`qymc` 等不支持条件，不提供隐式名称发现或切换来源。`all` 要求 `startPage=1`；续查按 `unfinished` 中每个单称号与页号分别查询。单称号零条仅表示该称号的指定范围无记录，不能推论三称号无记录。例如回归代码 `91330211255994457P` 的受控样本在1/2零条、3有六条关系；不按USCC去重，也不推断企业身份、原因或措施。

`queryList` 的 `name` 是平台 `qymc` 关键词（全称也可），`uscc` 是 `tyshxydm`（18位大写字母/数字）；至少一个必填。同时提供时两个字段同时传给平台，按 AND 组合；名称结果仅为候选，不能据此自动确认身份。未添加日期、区域或称号过滤。`queryList` 不接受 `rdjb`；queryList/businessList均不接受日期、区域、排序或其他未知字段，REST 和原始 MCP RPC 均明确拒绝，不能静默忽略。不接受 Cookie、凭据或账号参数，不能先调用 reveal。

`queryBusList` 接受名称、代码及两者的 AND 组合，至少一项必填。它请求 `ZjtxxjrBusInfoManageBLH/queryBusList`，解析 `businessGrid`；即使响应 Content-Type 是 text/html，也按正文解析 JSON。它不是 `businessList` / `business_list` 或 `apply_list` 的别名。

| 参数 | 默认 | 允许范围 |
| --- | --- | --- |
| pageSize | 50 | 1–50 |
| startPage | 1 | 1–100000 |
| maxRequests | 100 | 1–100 |
| maxRows | 5000 | 1–5000 |
| maxDurationMs | 60000 | 1–60000 |

实际每页大小为 `min(pageSize,maxRows)`，见结果 `limits.pageSize`。本次单项入口不自动重试；失败直接给未完成页，认证失效不重试。每请求超时最多15秒，受操作剩余时间进一步限制；总时间包含全局预算排队等待。进程内所有平台消费者（包括旧 reconcile）共享最多2个请求槽位；响应正文读取和旧客户端退避期间也占用槽位。多进程部署需要外部共享限流器，本实现按现有单进程 Nitro 运行边界提供预算。

queryList/businessList 返回的 `pageSize` 可以缺失；缺失不代表已验证平台实际页大小。若显式返回，必须是可靠整数且与请求的实际大小一致，否则该页不纳入结果并保留为 unfinished，防止续查偏移跳过记录。queryBusList 继续要求实际页号与页大小，并校验 maxPage。live parser 只接受非负安全整数或纯十进制整数字符串作为可靠数量/分页元数据，布尔、数组和纯空白不转换为数字；旧历史解析及存储契约不变。


### queryBusList 已验证筛选

| 参数 | 语义与限制 |
| --- | --- |
| rdjb | `['1']` 创新型中小企业 / `['2']` 专精特新中小企业 / `['3']` 小巨人；可组合，非空且不重复；缺省依次查全三称号 |
| sqsj | 认定时间范围，格式严格为 `YYYY/MM/DD - YYYY/MM/DD`，真实日历日期且起始不晚于结束；不承诺端点包含规则或平台时区 |
| rddqrq | 四位有效年份（例如 `2027`），不是精确到期日期；不推测平台当前年份选项的永久上下界 |
| whpcyear | 四位维护年份（例如 `2023`），可能与 rdtime 的年份不同；返回行该字段可能为空 |
| whpc | 维护批次字符串 `1`–`15`，必须与 whpcyear 同时提交；拒绝独立批次，实测平台会忽略独立批次；不是 `YYYY-N` |
| szq | 账号可见范围内的8位筛选码；必须由该账号页面取得；这里只校验8位格式，不能证明代码属于当前会话选项。没有全局区域字典，不根据结果行转换 |
| orderField / orderDirection | 必须一起给出，仅支持 `qymc` 与 `asc`/`desc`；其他字段未功能实证，明确拒绝 |

所有主动条件回显在 `effectiveConditions`，所选称号回显在 `titleScope` 与逐页位置；不把维护年/批次转成公告认定事件。即使不带筛选，结果仍限于服务端会话账号的可见范围，不能声称全国全局穷尽。实测账号中余姚筛选码为 `33028100`，返回行 `szq` 却是 `133028100`；不能将行值直接用于筛选，也不应据此推导通用转换规律。

```json
{"source":"queryBusList","name":"合成","rdjb":["1","2","3"],"sqsj":"2024/02/01 - 2024/02/29","rddqrq":"2027","whpcyear":"2023","whpc":"2","szq":"33028100","orderField":"qymc","orderDirection":"desc"}
```

queryBusList **不使用 nextPage**：实测中间页仍返回1。按请求页号递增，核对响应 page、pageSize、maxPage 和可靠 maxCount；短中间页、页号/总数/最大页变化或矛盾均不报告完整。缺失可靠 total 时明确返回null，可使用一致的 maxPage 结束；两者均未知时取至有效空页，仍受全局请求/行数/时间上限约束。已认定来源要求响应 page/pageSize 与请求一致，不能在分页形态无法确认时声称查全。多称号是依次分页，不提供跨称号全局排序或原子快照保证。

## 结果与完整性

共享类型、输入/输出 schema 在 `lib/platform/live-query.ts`，服务在 `server/utils/platform-live-query.ts`；静态 OpenAPI schema 在 `server/api/platform/query.post.ts`。后续来源沿用结果和页位置类型，不能把关系按代码去重。

- `source`：实际平台来源；`effectiveConditions`：实际条件和 `combination:"and"`。
- `titleScope`：`queryList` 为 `{mode:"source_default",rdjb:[]}`，表示未施加称号过滤，不表示逐称号已查证。`businessList`/`queryBusList` 为 `{mode:"selected",rdjb:[所查称号]}`；all为 `["1","2","3"]`。
- `queriedAt` / `completedAt`：本次开始/完成时间（ISO）；无缓存。
- `rows`：全部逐条原字段（沿用适配器的标量字符串化），不压缩同码多关系/曾用名，不返回原始页面或无关账号信封。
- `pages`：逐页来源、rdjb（queryList为null，businessList/queryBusList为实际称号）、page、status、fetchedCount、declaredTotal、error。
- `declaredTotal`：可靠的上游声明数量；缺失/无法可靠解释时为null，不能用0代替未知。businessList/queryBusList仅在所有要求称号均取得可靠总数时返回其总和，否则为null；各称号声明总数见对应pages。
- 已观察到的称号总数在后页缺失/非法总数时仍约束本次查询；逐页 `declaredTotal` 保留该页实际声明，缺失为null。批次显式重试从既有成功页恢复该约束，矛盾空页不能清除 unfinished；单独发起的 REST/MCP 续查只拥有该次观察，调用者仍需保留先前结果。
- 批次重试按称号及页号恢复连续成功页的实际 `fetchedCount`，不把此前每页当作满页；从重启后的 checkpoint 重试也沿用这些计数。独立续查若无法确认此前覆盖量，且响应没有可验证的实际页号/页大小，就不能凭请求大小和正总数判断已取全；矛盾空页保持 unfinished。响应提供经校验的分页边界时可完成所请求的剩余范围，`fullRange:false` 仍不代表从第一页穷尽。
- `fetchedCount`：返回记录数；`completeness` 为 complete / partial / not_queried；`fullRange` 为是否从第一页开始。
- `unfinished`：可继续的 `{source,rdjb,page}` 位置。续查保留相同条件和结果中 `limits.pageSize`，设 `startPage`；queryBusList 应逐个 unfinished 位置设置单称号 `rdjb:[该位置rdjb]`，不要把某称号的续页应用于全部称号；各次结果按页保留，不按USCC去重。续查完成仅表示所请求的剩余范围完成，`fullRange:false` 不能声称从头穷尽。
- `error`：固定code与安全文案，不包含上游原文、Cookie、异常原文或凭据存储细节；成功为null。

| status | 含义 |
| --- | --- |
| success | 请求范围完整且非空 |
| no_record | 请求范围完整且有效零条，仍需检查fullRange及条件 |
| auth_failed | 尚无成功页时认证失效（包括HTTP200登录页） |
| failed | 尚无成功页时上游、限流、超时或响应错误 |
| partial | 已完成部分页后失败，或安全上限中断；unfinished定位未完成页 |
| not_queried | 凭据不可用，未请求平台，绝非零条 |

错误code包括 `invalid_input`、`unsupported_source`、`credential_unavailable`、`auth_failed`、`upstream_failed`、`timeout`、`rate_limited`、`safety_limit`、`invalid_response`、`sensitive_response`。REST非法输入为HTTP400 `{error:{code,message}}`；MCP原始RPC非法输入为HTTP400 / JSON-RPC -32602。有效查询中的业务失败/partial保留统一结果（REST HTTP200）。只有所有选定称号及请求页成功完成且零条才返回no_record。queryBusList 失败后停止，unfinished 同时包含当前失败页与其余未查称号的起始页。未知总数继续请求至结构有效的空页；空页与已声明总数矛盾、页号不一致或总数变化时不能声称完整。

businessList 的 `pages` 按称号、页顺序排列，`rows` 按成功页顺序连接；每个成功页的 `fetchedCount` 给出其在rows中的连续段，失败页为0。这样保留每条原始关系的来源/称号/页位置，不向原字段中注入或覆盖rdjb。每个所选称号没有unfinished位置且其pages成功完成才算该称号完整；未请求称号没有page且保留unfinished。单个称号/页上游失败继续其他称号，认证失效停止后续称号；整体只要有unfinished就不能报告no_record。凭据不可用时全部范围not_queried。三称号共用一次maxRequests/maxRows/maxDurationMs预算，不是每称号重新计数。

达到行数上限时保留已完成整页，不截断单页。若下一页无法整页纳入，则该页不进入rows，unfinished仍指该页；调用者可提高上限后补查。请求/时间上限同样返回partial及位置。

## 无凭据调用示例

```sh
curl -sS http://localhost:3000/api/platform/capabilities
curl -sS http://localhost:3000/api/platform/query \
  -H 'Content-Type: application/json' \
  -d '{"source":"queryList","name":"合成","maxRequests":10}'
```

MCP业务参数（由客户端包装tools/call）：

```json
{"name":"query_platform","arguments":{"source":"queryList","uscc":"91330211255994457P","maxRequests":10}}
```

第二页失败/上限后补查：

```json
{"name":"query_platform","arguments":{"source":"queryList","name":"合成","startPage":2,"pageSize":50}}
```

只有完整收到所有要求的页、确认条件和称号范围后，才评估证据是否穷尽。平台当前申报事实不能替代公布文件的历史认定事件；身份确认和预检/写入仍走独立流程。

businessList 全三称号示例（只读）：

```json
{"name":"query_platform","arguments":{"source":"businessList","uscc":"91330211255994457P","rdjb":"all"}}
```

若返回 `unfinished:[{source:"businessList",rdjb:"2",page:2}]`，则用相同USCC、`rdjb:"2",startPage:2` 和结果的 `limits.pageSize` 补查；保留原查询和本次范围，不能把续查的零条提升为全三称号无记录。

## 凭据与后续接入

凭据使用现有 `resolvePlatformCookie`（保存值优先、否则环境）；服务仅在操作开始解析一次，固定在内存中。#54 批次可通过 `PlatformLiveQueryContext.cookie` 提供提交时内存快照，严禁把context序列化到任务参数。没有新增持久化结果/缓存/数据库表。敏感业务字段或凭据回显会阻止该页返回，原始信封不输出。查询响应设no-store。

新增来源必须复用 `postPlatformRequest`（`lib/platform/client.ts`）或 `withPlatformRequestBudget`，不能绕开全局预算，也不要在已持有槽位时再次获取槽位。能力表仅启用已实现且验证的参数。businessList已提供逐称号位置；#53仅开放已实证筛选；#54需独立定义批次总量/体量及重启策略。

## 验证边界

`tests/platform-live-query.test.ts` 经实际REST handler与MCP handler覆盖分页、关系保留、失败、续查、严格参数、合成凭据安全、SQLite不变、快照及共享限流，并包含真实本地HTTP调用。上游为受控脱敏样本；没有使用真实Cookie、调用实平台或写入业务数据。公开能力的上游名称搜索/组合过滤语义仍应由维护者在受控账号下补充实平台验收，本次不能把模拟验收提升为实平台证据。

#52 的 `tests/platform-business-query.test.ts` 独立覆盖公开 REST/MCP 的 USCC/单称号/全三称号、多页六关系与原始曾用名、逐称号失败后补查、认证失效停止、未知总数、安全上限、原始RPC严格验证、合成凭据保密与真实临时SQLite不变。样本均为受控合成/脱敏数据，无真实认证或业务写入；不宣称实平台账号验收。

`tests/platform-recognized-query.test.ts` 补充已认定来源的三页/三称号、全部筛选与原始RPC严格校验、独立来源和原字段、失败/上限/单称号续查、能力/OpenAPI及REST/MCP对等。queryBusList 的上游能力依据维护者提供的 2026-10-18 浏览器实测：三个称号、名称/代码、日期范围、年份、维护年+批次、账号区域码、qymc双向排序，以及20/20/10的完整三页（total50）。实测没有验证日期边界是否包含、平台时区、全局区域字典或其他排序字段。本实现的 REST/MCP 验收使用合成/脱敏样本，不能把上游浏览器观察当作应用入口的实平台验收。queryList 的上游组合语义仍需维护者受控验收。

## Async batches

Use [platform-batch-query.md](./platform-batch-query.md) for authenticated batch
submission/retry, read-only status/progress/individual results, stable IDs,
unfinished-only retries, bounded retained results and restart policy. Batches
reuse this single-query contract and the same global request budget. Agent
investigation uses these app APIs/MCP and never needs a Cookie read/reveal.


#59 新增逐页可空 `maxPage`（queryBusList 原响应末页），供独立显式转存核验。查询本身仍只读；[归档转存契约](platform-recognized-evidence.md) 说明 recognized_list、旧归档元数据缺失的拒绝规则及批量 segments 转存。

### 申报与关联归档的标准字段

`apply_list`（queryList）与 `business_list`（businessList）的归档写入、完整 REST/MCP 读取、企业详情、原行详情和已有候选共用平台解析器：`cszt → status`（办理状态）、`sblx → declareKind`（申请/更新/复核转 apply/update/review，其他原样保留）、`sqsj → appliedAt`、显式 `year → year`、`whpc → batch`，并保留 `szsfmc/personuuid` 的既有映射。平台年份不表示正式认定年，也不从申报时间推断。

历史只存 rawFields 的关系在读取时补齐缺失标准字段，不回填数据库。新归档保存同一解析结果；已有非空标准字段与非空原值矛盾时，预检/提交返回 `platform_field_conflict`，不静默覆盖。旧冲突行的相关标准值返回 null，同时返回 `normalizationConflicts[{field,storedValue,rawValue}]`，页面明确待核，候选保留冲突。原始 rawFields 中的缺字段、null、空白、明确未知与未知枚举保持可区分；原响应文本不修剪。

`recognized_list`（queryBusList）继续只在原字段中表达认定快照，不借用 `cszt/sfyx` 生成办理状态或流程类型。查询成功/失败状态与关系的办理状态各自独立。按字节分段取证端点返回持久化原档，历史空列仍为空；它与补齐标准字段的业务读模型不同，关系 ID 和原始证据保持不变。

## 原 JSON 兼容扩展（#326，capabilities v3）

需要原行时，在 REST `/api/platform/query`、MCP `query_platform` 或批量 `items[].query` 显式传 `rawDataVersion:1`。缺省继续返回旧字符串 `rows`；不从旧字符串反推 null、数字、布尔或对象。扩展结果新增：

```json
{"rawData":{"version":1,"rows":[{"id":"same","x":null,"n":1,"b":true,"o":{"a":1}}],"pages":[{"source":"queryBusList","rdjb":"2","page":1,"format":"json","body":"完整原响应"}]}}
```

`rawData.rows` 是原响应解析得到的 JSON 行，保留缺键、null、数组、未知字段和原型同名自有键；`rows` 仅供旧消费者读取字符串投影。两者各有含义，不能互相回退。`rawData.pages` 按实际接受的成功页顺序保存 source/rdjb/page、解析形式（json/html-script/html-table）与未经裁剪的正文，包括空白。HTML table 只能观察单元格字符串，不能推测上游 JSON 类型；原 HTML 仍保留。失败/拒收页不带原文，不冒充已接受页。

扩展单查结果预算为8MiB；批量沿用原 `maxResultBytes`。原响应、typed 行、旧投影和已有结果一起计量，放不下就整页拒收、标 partial/safety_limit 并保留 unfinished，不截断原文。与已知服务端凭据匹配或含敏感键的原响应拒收，不能先脱敏再称完整原文。未选择扩展的旧消费者继续原有行为；批次原条件保留 rawDataVersion，分段和补查继续使用同一格式。

HTML 响应与 JSON 响应一样按原文保存，不限制页面标签、属性、脚本数量或 DWZ 包装函数内容，也不执行其中的脚本。凭据回显、敏感字段和结果体积检查仍保留；转义解码只用于凭据检测，不改写归档正文。页码、行数和结束位置仍按接口实际返回核对，读取失败不能作为零记录。失败页保持 unfinished，先前已接受的页仍原样保留。table typed 行的自有原型同名列保留，旧字符串投影的行为不变。

认定归档详见[封套转存](platform-recognized-evidence.md#原json封套扩展与后续接缝326327)。#327 由统一 importer 按 rawData.version=1 选择真实原行进入 relation.rawFields/业务内容版本；旧格式保持字符串，不回推历史类型或重算旧hash。capabilities.rawData.archiveRelationHash=rawData_v1_or_explicit_legacy_rows。#298 仍须父组合验收，不表示生产迁移完成。

## #480 差异快照任务

每个新的 clientRequestId 先备份并冻结公布名单全部企业，然后逐企业新查 queryList、businessList、queryBusList。历史任务或外部查询归档仅属历史证据，不能填充新任务完成状态或断点。相同 clientRequestId 返回原任务；retry 只续用同一 snapshot job 的成功页，失败尝试和原始位置继续保留。collectionPolicy 为 per_enterprise_fresh_same_job_resume。

未知总数遵循 provider 有效空页结束协议，允许此前存在短尾页。重试从所有保留的成功页恢复可靠声明总数；合并后的连续页覆盖必须满足已知总数和最大页约束，矛盾或缺口保持未完成、覆盖行数 null。
