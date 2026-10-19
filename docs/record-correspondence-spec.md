# 认定与流程记录对应规格（#63，待独立评审）

**状态：提案 / 未批准 / 未实现。** 2026-10-18。#63 为 `scope:XL`，本文件和[拟议 ADR](adr/2026-10-18-record-level-correspondence.md)仅供独立评审；评审接受后才可另建每项不超过 M 的实施票。本次不授权 schema、接口、页面、数据迁移或生产回写。本文的“应”“拟议接口”均是目标契约，不表示现有能力。

依据：[GitHub #63](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/63)、[#14](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/14)、[#34](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/34)、[冻结生命周期契约](roster-lifecycle-contract.md)、[已认定证据归档契约](platform-recognized-evidence.md)、[已采纳生命周期 ADR](adr/2026-10-16-roster-lifecycle-model.md)、`GLOSSARY.md`、当前 `db/schema.ts` / `lib/comparison.ts` / `lib/platform/live-query.ts` 与已公布 REST/MCP 路由。#63 的新对应语义优先作为**待审批增量**，不暗改上述冻结契约。

## 1. 问题、目标与现状边界

当前 `/api/comparison` 通过 `record` 中的经信局来源与工信部来源、按企业×称号去重后比较 USCC 集合；`lib/comparison.ts` 明言不关联事件，包含复核、培育等历史条目。`difference_reason` 可引用某次 `platform_query`/`platform_relation`，企业详情也独立展示接口原行，但这些引用未表达“这条正式事件对应哪条平台流程/认定行”。一个历史认定已与平台当年通过相符、后来更新退回的企业，仍可能仅因当前导出消失被归为旧式差集。本规格建立**可审计的记录级对应**，先查对应和查询完整性，再陈述差异；历史权威与当前快照继续分开。

现有稳定事实：`record_event` 承载事件，`record_evidence` 承载文件/附件/名单序号/PDF 页；`platform_query` 自然键是 `(interface, query_key, rdjb, queried_at)`，`platform_relation` 是 `(query_id, sequence_no)`；`platform_export_batch` 以 `(title_code, year, sha256)` 辨别版本，行以 `(batch_id, source_row_no)` 定位。`recognized_list` 唯一对应实时 `queryBusList`，原条件、页、行、查询及完成时间在 `collectionEvidence` 保存；旧查询可能没有该字段。统一名录 `preflight` / `commit` 与 MCP 同类能力已存在，但**对应关系的读写及新对比尚不存在**。实时查询成功或归档成功均不等于业务对应已确认。

### 不变量

1. 正式公布附件决定历史称号事件；平台流程、认定行和导出行只证明各自来源的陈述，不改写、删除或代替正式事件。所有正式名单行保留，包括没有导出匹配者。入库培育 `nurture` 不冒充认定。
2. 对应以**具体行**为端点。一次查询不代表其中所有行都已匹配；查询成功零行不是事件正面出处；保留每条接口原行、导出原行与旧查询。
3. USCC 身份优先，缺失或冲突留空待核。同名、名称归一化、查询键命中、平台属地、时间近似均不是自动确认企业身份的充分条件。不得跨称号确认；平台维护批次 `whpc` 与正式批次、申报 `year` 与正式结论年各自独立。
4. 软件只做类型、身份、范围、唯一性、并发与审计校验；具体注销、迁入迁出、更名、平台未更新等原因由代理/用户取证判断。`pending_review` 是已核实的在途原因，区别于证据不足的 `needs_review`，也不等于复核失败。
5. 任何对应、解除或旧结论修订只追加可追踪决定，不改原始查询/行和正式文件证据。旧结论先归档或标待复核，不静默覆盖。

## 2. 领域词与时间

| 概念 | 精确含义、身份与权威 | 时间语义 |
|---|---|---|
| 正式事件 | `record_event.id` 加所属 `record` 的企业、称号、`source=jxj`；`award`、`review` 等事件各自存在。`record_evidence.id` 定位正式出处。 | `year` 对复核可指被复核的原认定年；`decided_year` 才是结论年，空值保持未知。文件落款年不能自动填它。 |
| 平台流程行 | `platform_relation.id`，所属查询必须为 `business_list`（关联/业务流程）或 `apply_list`（申报流程）。`relation_key` 是可空的平台业务号，重复或缺失时仍以查询 ID＋序号定位。 | `applied_at` 是平台给出的提交时间；`queried_at` 是采集时间。`batch` 是维护批次，`award_batch_label` 是接口原“认定批次”文字，均不直接等同正式批次。 |
| 平台已认定行 | `platform_relation.id` 且查询 `interface=recognized_list`。原 `raw_fields` 可含认定/到期字段、平台属地；`sourceRdjb` / `sourcePage` 是归档定位。 | 原始业务日期依字段含义解释，不能由 `queried_at` 推出认定时间。 |
| 当前导出行 | `platform_export_row.id`＋`batch.id`／`sha256`／源行号，代表该文件收集范围内的现状。 | `collected_on` 是采集日期，不保证与实时接口 `queried_at` 的瞬间、服务端版本一致。 |
| 对应决定 | 一条特定类型边及其版本化确认依据；可多对多。候选不是事实，已确认也只确认注明的角色。 | `decidedAt` 是作出对应决定的时间，不是业务发生或原始采集时间。 |

平台原业务标识、查询自然键、原字段和文件哈希都要保留；数据库行 ID 在本次数据库中稳定，但导出/恢复或跨环境传递时须连同自然键与来源版本核验，不能裸 ID 猜行。对应规则 `ruleId`、`ruleVersion`、输入证据指纹和产生时间随候选记录；升级规则不批量改写已确认关系。

## 3. 拟议对应模型与证据角色

一个深接口承载类型校验和状态转换，REST/MCP 只是适配器；存储形态由后续设计票定，但须满足下列**判别联合**，不得做没有类型/角色约束的“企业 ID ↔ 查询 ID”泛链：

| 类型 | 左端 | 右端 | 角色和可得结论 |
|---|---|---|---|
| `event_process` | 正式 `eventId` | `business_list` 或 `apply_list` 的 `relationId` | `supports_award`、`supports_review` 或 `context_only`；写明原流程状态与所支持的具体事实。`context_only` 不足以宣称结论一致。 |
| `event_recognized` | 正式 `eventId` | `recognized_list` 的 `relationId` | `recognized_corrob`：仅佐证平台在该次查询中的认定行与该正式事件可对应；若该行只证明当前在册，标 `current_context`，不回填历史认定年。 |
| `later_process` | `enterpriseId`＋`titleCode`，可选 `predecessorEventId` | `business_list` 或 `apply_list` 的 `relationId` | `followup_apply`、`followup_update`、`followup_review`；可独立于任何正式事件存在，关联前驱时也**不自动成为前驱结果**。 |
| `event_export_context` | 正式 `eventId` | 指定版本的 `platform_export_row.id` | `current_snapshot_context`：该行是事件详情可追溯的当前快照出处，不证明历史事件结论，也不改写正式出处。可无认定接口行。 |
| `process_export_context` | `business_list` 或 `apply_list` 的 `relationId` | 指定版本的 `platform_export_row.id` | `current_snapshot_context`：该行是流程详情可追溯的当前快照出处，不代表流程已获正式认定。可无认定接口行。 |
| `recognized_export` | `recognized_list` 的 `relationId` | 指定版本的 `platform_export_row.id` | `same_current_row`／`candidate_same_current_row`，只用于同范围现状一致性；认定行可作中介，但不是事件/流程关联导出行的必经端点。 |

同一事件可连多条流程/认定行，同一平台行可因不同正式附件或复核事项连接多个事件，但每条边必须逐事件说明支持的事实；同一对端点、角色和有效版本只计一次。已确认的 `event_process` `context_only` 可以表示**同批次流程确实对应此事件**，即使原状态与正式结论相冲突；对应事实与结论一致性分别判断。后续流程与旧事件可能并行展示；其状态不会覆盖已确认的历史事件结果。导出行可与多条事件、流程或平台已认定行候选相连，但未消解重复行之前不宣布一对一事实。事件/流程与导出行须核验主体、称号、版本、原行及采集范围；这种边只说明快照观察与该记录的上下文关系，不作为历史结论、平台已认定或缺失的证据。不存在匹配导出行时仅记录导出批次的范围、版本与覆盖完整性；只有已证实覆盖目标范围才可作为**负向覆盖证据**，否则标覆盖未知，不创建空端点、零行或“缺失行”的正向对应。物理记录应有独立 `correspondenceId`、边类型/角色、目标自然身份、状态、规则版本、依据、创建/决定/失效时间和 `revision`；审计独立追加，不以删除表示解除。

### 候选与身份门槛

- 第一层确认企业：两侧有效 USCC 相等且指向同一已核身份可生成高确定性候选；矛盾 USCC 必须阻断确认。缺码时，已确认且有原行出处的曾用名/人工主体决定可作为依据；仅同名、`queryKey=name:…` 或展示时按查询键补出的行都只能待核。归属 `platform_relation.enterprise_id` 的现有含义是**企业主体**，不是事件对应。
- 第二层确认称号：正式事件所属 `titleCode` 与 `rdjb`/`sourceRdjb` 或明确原字段一致；多称号查询必须定位到该行的原称号，未知则候选待核。跨称号禁止确认。导出批次 `titleCode` 同样精确。
- 第三层确认事实：`eventType`、原认定年份/批次、结论年、平台流程类型 `declare_kind`、业务状态和日期逐项呈现原值及解释。缺年、批次、类型或出现复核与新申请混杂时不得按时间“最近”唯一选中。`business_list` 的 `awardBatchLabel` 可以是线索，必须经来源语义解释才可支持正式批次。
- 唯一性可判定且规则经批准的场景可自动形成唯一**候选**；是否允许规则直接确认属于后续切片的单独评审门槛，默认仍要求代理/用户显式确认。歧义、多主体、关系冲突、同一平台号跨查询重现均展示候选集合，不择首条。

### 状态转换与审计

`unexamined → candidate → confirmed | rejected`；`candidate → rejected` 保留拒绝原因；`confirmed → unlinked` 是显式解除而非删除；更正为 `confirmed(old) → unlinked(old) + confirmed(new)`，两步同一原子事务与审计关联。被拒候选只有输入证据或规则版本变化才可重新提名，并显示先前拒绝；解除不自动恢复旧候选。每次决定保存操作者类型及标识（代理/用户）、时间、来源行、原条件/版本、规则、依据文本或正式出处引用、前后状态、expected revision、请求幂等键。只可对当前 revision 转换；过期计划返回冲突并要求重新预检。接口校验依据可追溯，不能假装已核验业务事实。

## 4. 对比语义、计数与资格

**先选明确的查询范围/时点/来源版本，再按具体记录形成判断。** 对每条正式 `award`/`review` 事件，先列其正式出处与已确认对应平台行，再列候选和独立后续流程。`nurture` 与维护记录另列，不纳入“正式认定事件缺对应”分母。既有 `missing_in_miit` / `extra_in_miit` 及 `difference_reason` 仍可供旧页面/审计读取；新的记录级结果使用新维度，不把旧方向当成已验证的新结论。

| 维度 | 判定与主计数粒度 |
|---|---|
| `historical_aligned` | 正式事件有足以支持**该事件所述事实**的已确认对应，且无已核实冲突；`distinct eventId`。可同时带 `has_later_process` 旗标，不再另加为“另一条历史事件”。 |
| `historical_conflict` | 已确认对应定位到**同一正式事件/批次**的具体平台行，身份、称号、流程类型和时序已核实；其原状态（如正式获批后同批申报仍待审核/退回）与正式结论相抵触；`distinct eventId`。报告双方原值、出处及查询时间。此为来源陈述冲突，不自动推断未认定、平台未更新或任何业务原因；缺已认定行须另按覆盖资格陈述。 |
| `historical_corresponded_later_process` | 历史已对应，另有独立后续申请/更新/复核在途、退回或不通过；主计数 `distinct enterpriseId,titleCode,relationId`，并单报涉及的事件数。后续状态不冲销历史一致。 |
| `official_without_correspondence` | 正式事件没有已确认的 `event_process`／`event_recognized` 对应；导出快照上下文边不算历史平台对应；`distinct eventId`，且只有覆盖该事件所需来源与范围的完整查询才可进一步叫“平台未见对应”。已有流程/认定对应但尚不能判断一致/冲突时归 `unresolved`，不算缺对应；覆盖不足也归 `unresolved`，不作业务缺失断言。 |
| `platform_without_official` | 已核主体与称号的具体平台流程/认定行，未连正式事件，且同范围的正式来源覆盖已确认；`distinct (interface,queryId,sequenceNo)`。独立后续流程不自动算作正式公告缺失。 |
| `unresolved` | 候选歧义、身份/称号冲突、缺业务字段、已有对应但事实/时序仍不足以判一致或冲突，或查询 incomplete / 未查询；按 `distinct eventId`、`distinct relationId` 和查询覆盖单元**分别**报，不把不同粒度相加。已核实的同批次状态冲突不因缺已认定行降为此类。 |
| `current_source_consistency` | 符合下节资格的已认定行和导出行，同一现状范围内已匹配／接口独有／导出独有／字段冲突；按 `distinct recognized relationId` 与 `distinct (batchId,sourceRowNo)` 分开计。无资格显示 `not_comparable`，不算“不一致”。 |

历史事件主分类以 `distinct eventId` 每事件恰落一类：先核验身份/称号/批次/时序；已确认同事件流程/认定行且结论相抵触为 `historical_conflict`（即使另有支持行），无冲突且有足够支持为 `historical_aligned`；有已确认流程/认定对应但事实尚不足则为 `unresolved`；无此类已确认对应时，完整覆盖为 `official_without_correspondence`，否则为 `unresolved`。身份或对应范围未核实时也为 `unresolved`，不能凭原状态直接报冲突；导出快照上下文不改变历史主分类。后续流程和当前一致性是**独立维度**。需同时返回原始行数、去重事件数、去重平台行数、去重企业×称号数与各自分母，分页前计数；同一行有多条边仍只按稳定行 ID 计一次。筛选/分页改变可见列表，不改全范围计数，另可返回筛选后计数且明示口径。不能把不同粒度的数字相加为“企业总数”，也不能只取最新接口行/最新历史事件。

### 已认定接口与导出的可比较资格

平台导出与 `queryBusList` 同源；出现矛盾时先检查解析、匹配、条件、时间、版本，不先猜“同步延迟”。逐称号比较的资格证据须**同时**满足：

1. 身份与称号范围相同：USCC 精确或经确认同一主体；导出批次称号与接口行 `sourceRdjb` 相同。接口的实际 `effectiveConditions` 按 AND 解释，`name`＋`uscc` 都存在时不能当 OR；`sqsj`、`rddqrq`、`whpcyear`＋`whpc`、`szq`、排序/分页、服务端账号可见范围须记录。不能把 `szq` 筛选码当成行的属地值。
2. 查询证明完整：`collectionEvidence.completeness=complete`、`fullRange=true`，所有目标称号页连续、到达有证据的末页、总数对账、无 unfinished；旧查询无 collectionEvidence、失败/partial/续页或单称号零行，均只说明实际覆盖，不证明全范围缺失。HTTP 200 登录页属于失败。
3. 导出来源与接口具有可证明**相等**的账号/地域/称号/筛选范围、采集窗口和平台数据版本或等效冻结证据。导出当前只有 `collected_on` 日期与文件哈希，接口有 `queriedAt`/`completedAt`，这些字段本身不能证明同瞬间同版本；没有版本/冻结证据时资格为 `unknown`，只展示并列观察，不下确定性“不一致”。
4. 对照以原行和批次版本为准，不因同码多行、重名或导出替换批次先折叠为一家；确认重复/版本关系后才产生去重视图，原始行数始终可读。

满足资格才给 `matched`、`interface_only`、`export_only`、`field_conflict`；不满足则返回 `not_comparable` 和逐项理由/缺失覆盖。完整零行只证明**该接口、该称号、该组 AND 条件、该时点**没有返回行，不生成正面事件出处；partial 已取得的行仍可作正面候选，但**未取得区域**绝不用于缺失断言。查询未执行、失败、认证失败、限制中断各自可见。若同范围同版本事实仍矛盾，标数据一致性待核，提供双方版本、条件、原行、计数和解析路径。

## 5. 拟议 REST/MCP 接口（评审后才实施）

所有读接口遵守现有分页上限和 OpenAPI 可发现性；MCP 输入/输出与 REST **语义等价**，需在 `tools/list` 公布类型。原始响应默认不回显大字段，按现有证据读取权限显式取回，响应 `no-store`。写接口复用统一名录鉴权、事务及批次审计：REST `NUXT_API_TOKEN`、MCP `NUXT_MCP_TOKEN`，未配置写令牌时关闭；不得要求代理读 Cookie/直连 SQLite。现有实时查询 `/api/platform/query` 与 `query_platform` 仍为只读，不暗中归档或确认。

| 目的 | 拟议 REST | 拟议 MCP | 契约要点 |
|---|---|---|---|
| 发现与读取 | `GET /api/roster/correspondences`；`GET /api/roster/correspondences/:id/audit` | `list_record_correspondences`、`get_record_correspondence_audit` | 按 eventId、relationId、exportRowId、enterpriseId、titleCode、类型、角色、状态、规则版本过滤；返回两端原行/正式出处定位、历史决定、分页与总数。事件/流程→导出行及导出行→事件/流程均可逐边读取，包含批次版本、源行号、采集范围/时间与快照角色；无匹配行时返回覆盖状态，不伪造行。审计按 ID 有序。 |
| 候选生成 | `POST /api/roster/correspondences/candidates` | `find_record_correspondence_candidates` | **只读**计算，指定事件/企业称号、允许的已归档查询 ID、导出批次 ID 和 `ruleVersion`；返回候选、身份/称号/事实字段逐项证据、冲突、覆盖及目标 revision；不抓平台、不写业务数据。 |
| 记录级对比 | `GET /api/roster/record-comparison` | `list_record_comparison` | 要求明确来源/正式覆盖范围、导出 batch ID 与接口查询集或 `asOf` 策略；返回 §4 各维度/粒度、资格及不完整原因，事件和行的正反向引用。默认只读。 |
| 预检决定 | `POST /api/roster/correspondences/preflight` | `preflight_record_correspondences` | 封套 `idempotencyKey`、`sourceKind`、`sourceIdentity`、`expectedRevision`/对象版本、`operations[]`；只生成固定目标与影响计划，逐项列 old/new、冲突、预期新增/解除/更正/审计数、受影响旧结论 ID，不改对应业务行。若沿用现有 import_batch 预检记账，须明确其“只读业务、可写记账”事实。 |
| 原子提交 | `POST /api/roster/correspondences/commit` | `save_record_correspondences` | 提交预检给出的 `planId`/`planHash`、同一封套/幂等键、所有 expected revisions；单事务验证目标、范围、当前版本和计划后写全部边与审计；逐项结果及读回引用。任何冲突整批零业务写。 |

这是一组**拟议能力**，不表示现有 `payload` 已支持对应边。现有 `sourceKind` 只有 `announcement` / `platform_export` / `alias_evidence`；拟议新增明确的 `correspondence_decision`（或经评审确认的等义类型），不能把对应决定伪装成“别名证据”。后续实现应优先将操作纳入 RL-11 的统一导入事务/幂等机制（可用新增受控操作类型或共用同一写入模块），而不是第二条无审计数据库写路；具体路由是否折叠到 `/api/roster/import/{preflight,commit}` 可在接口评审中确定，但以上原子性与客户端语义不变。预检结果需绑定具体目标、原值、输入哈希和数据库 revision；提交不重新以名称搜索替换目标。相同幂等键＋同请求指纹返回原回执，不重复审计；同键不同载荷冲突。提交响应丢失时以**原键**查询回执并读回，不换键再试。错误至少区分 `invalid_endpoint_type`、`identity_conflict`、`title_conflict`、`ambiguous_candidate`、`incomplete_coverage`、`stale_revision`、`plan_mismatch`、`idempotency_conflict`；409 用于并发/幂等冲突，422 用于确定性语义拒绝。预检与提交影响须一致，漂移则拒绝并重新预检，不“尽量提交”。

企业完整页拟按事件展开正式文件、三接口**具体行**及有对应时的导出原行；流程详情也展示其对应导出原行。每项显示来源、查询/导出版本与范围、原时间、原状态、业务号或源行号、对应角色与确认状态；快照上下文与正式事实分开标识。独立后续流程另列；接口行及导出行可反向查看关联事件/流程，认定与导出一致性另列。无导出行时显示覆盖状态及其条件，不显示虚构行。中文业务名称与原文优先，内部 ID 在证据详情中；既有文件预览、PDF 实际页码、返回位置保持。后续 UI 票须在桌面和 390px 真实交互验收。

## 6. 既有结论、#14/#34 与迁移

#14 的企业身份、公布权威、三称号、别名、三年复核、导出快照与统一入库原则继续有效；本规格只为**记录对记录**增补对应及新对比，不改变已有 `record`/`record_event`/`record_evidence` 的含义。`difference_reason` 的旧 `enterpriseId,titleCode,direction,recordedAt` 行、`pending_review`、人工标注、离线解释缓存和现有 `/api/comparison` 均是**历史或兼容读模型**：保留原值、来源和审计，映射新维度须显式标 `legacy_pending_review`/`legacy_applicable` 或 `archived`，不能自动把旧 `confirmed_reason` 提升为某事件的确认对应，也不能静默变更/删除。已写的 175 条及 260 家工作集只是待复核输入，不是新模型正确答案。

#34 负责**既有正式事件 metadata 与文件出处坐标**的精确更正：eventId＋所属记录和旧值、evidenceId＋文件身份/hash 和旧坐标定位；新对应功能引用稳定 eventId/evidenceId，但不能借“重新导入”改事件自然键或用 bare `listNo` 猜出处。若 #34 更正改变了已确认边的依据，为该边加 `requires_revalidation` 待核标记（不删除旧确认和审计），先预检影响、再由明确决定修订；两类操作可共享 RL-11 的事务能力，但权限、计划和审计各自可辨。本规格不代做 #34，不触碰页码专用 API。

**迁移顺序（未来需另获用户授权）：**

1. 只读盘点已有事件、三类归档查询的全部行、导出各版本、旧差异/已确认原因与人工标注；记录查询是否有完整 collectionEvidence、原条件/时间、重复业务号、缺码/跨称号冲突与疑似对应。可在隔离副本演练，不从生产补抓或写回。
2. 生成带规则版本的候选和**影响预览**：原结论 ID、拟对应边、可能从旧差集移出的行、新维度/计数变化、不足以判断的范围、审计数量。数据问题与模型问题分列，所有未匹配正式行保留。
3. 用户检查并**明确确认具体计划**后，代理经公开预检/原子提交 API 执行；计划过期或任何目标漂移则整批拒绝。逐项读回、核对计数和审计，未确认项仍待核。不能通过新幂等键或 SQL 绕过冲突。

## 7. 九个合成验收案例（未来切片使用）

| # | 输入与操作 | 必须观察到 |
|---|---|---|
| 1 | 企业 A 2021 正式认定，2021 平台同称号通过行确认对应；2025 更新退回，2025 无新公布，当前导出缺行。 | 2021 事件 `historical_aligned`；退回是独立 `later_process`；当前缺行仅在可比资格成立时单列，不撤销历史。 |
| 2 | 企业 B 新批次正式获批后，同批次申报行在随后查询中仍待审核/退回；主体、称号、批次与时序核实并确认 `event_process` 对应，无已认定行。 | 正式事实保留；该事件报 `historical_conflict`、按 `distinct eventId` 计一次，展示平台流程原状态与正式结论；既非缺对应也非证据不足。未查到已认定行仅按实际查询覆盖陈述，不生成正面行；“平台未更新”等原因留待代理/用户取证，不自动判。 |
| 3 | 企业 C 2024 复核终审不通过，2025 新申请/更新；同称号多行，时间最新的是新申请。 | 复核结果和新流程分别可查，新申请不覆盖失败复核，也不自动恢复资格；首次认定仍按最早正式 award。 |
| 4 | 同一企业有两称号、同称号两批正式事件；一次 `business_list` 六行和一次 `apply_list` 两行，查询含重复平台业务号。 | 多对多对应逐行定位、原行全数保留；不能跨称号/年份；未对应行仍计未对应，不能把查询整体当成匹配。 |
| 5 | 同码的已认定接口行与指定导出行存在，随后再构造同范围同版本条件下字段矛盾。 | 有资格时先判已匹配，矛盾给 `field_conflict` 与两方行/版本/条件；只给同日但版本未知时 `not_comparable`，不误报导出缺失或猜同步延迟。 |
| 6 | 三称号查询只完成一个称号、另一个 auth_failed；另有单称号完整零行。 | 已取得行可作正面候选；未覆盖称号不报缺失；完整零行仅为该称号/AND 条件的负向覆盖，无正面事件出处。 |
| 7 | 缺正式年度/批次、同名两主体、异常名称、平台 USCC 冲突与不确定流程类型。 | 候选列原值/冲突，API/MCP 均阻止自动猜身份或跨称号确认；代理可确认有充分依据的唯一行或拒绝候选，其他留空待核。 |
| 8 | 从企业页的一个事件与一条流程分别打开导出原行、三接口行和正式文件页，再从导出/接口行返回事件或流程；另取没有认定接口行但有导出行、以及没有匹配导出行的样本；390px 与桌面分别操作。 | 无认定行时仍能直接正反向到导出具体版本和行；无导出行时仅见覆盖状态而无伪造行；独立后续流程有独立区块；文件/页/返回上下文不退化；来源角色、采集时间、确认状态可读。 |
| 9 | 预检同时确认、拒绝、解除、更正多条边；提交前更改一条 revision，重放原键再用同键异载荷。 | 漂移整批拒绝且无半写；重新预检后影响与提交/审计数一致；原键同指纹重放无新增，同键异载荷冲突；旧结论归档/待核可读，无 SQL 回写或凭据泄露。 |

以上为**合成验收设计**，本次文档提交未运行这些场景、未运行测试、未接触真实平台或业务数据库。

## 8. 未来 ≤M 切片与依赖（仅提案，不建票）

```text
独立评审批准本 Spec/ADR
  ├─ A 记录级对应契约与持久/审计操作（≤M；先）
  │    ├─ B REST/MCP 候选、预检、提交与读回对等（≤M；依赖 A，复用统一写入）
  │    │    └─ C 对比读模型与计数/完整性资格（≤M；依赖 B 的确认语义）
  │    │         └─ D 企业详情正反向出处展示（≤M；依赖 C 的读取契约）
  │    └─ E 旧结论只读盘点、候选/影响预览（≤M；依赖 A/B）
  │         └─ F 显式确认后的隔离迁移与 API 读回（≤M；依赖 B/E，单独授权）
  └─ #34 正式事件/文件出处精确更正（独立路径；更正影响需反馈 A/C 的再核验）
```

每个后续切片需重过 scope-gate、定义独立可验收接口与 PR；若 A/B 仍跨 schema＋REST＋MCP，则再拆。D 的浏览器实测和 F 的真实数据操作与本 Spec 评审分别授权。当前没有这些子票，也没有由本文件自动产生的实施许可。
