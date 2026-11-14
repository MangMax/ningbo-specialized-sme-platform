# 从文件到名录记录

接收整批文件时先执行[负载编排](orchestration.md)：清单、转图/OCR、纠偏、身份、写入和验收共享资源预算；文件/页图数量增加只增加待处理队列，不按页或按文件无限启动代理。

## 文件清单

逐份记录原始文件名、类型、哈希、来源、用途、重复关系和处理状态。正式公布及名单附件是称号依据；三张工信部表是平台现状对照快照。不能仅从通知正文创建名单行，须检查附件并保留全部范围内正式行，包括未匹配导出的行。

文件范围只有一个规则来源：[可执行文件范围规则](../../../../lib/file-store-scope.ts)。决定文件是否入库前先读该规则，不通过手工放置或删除文件绕过规则。

重新处理已有文件或批次前，查看应用当前状态并复用已完成、已核验的结果；只补齐或修复具体缺口，不无故重跑完整入库。

## 提取与交接

- PDF 每页转为可按页定位的图片；DOCX/XLSX 直接解析文字，不对办公文档做 OCR。
- 按[共享并发限制](./orchestration.md)提交页图 OCR。某页失败不影响保留其他成功页。
- 每份文件一名负责人。所有页均有结果后立即交接纠偏；失败页明确列出，文件保持部分完成，直到恢复或明确接受其为未解决项。
- 交接包含源文件 ID/路径、附件、总页数、页图引用、每页 OCR 文字、失败页、预计名单行范围及当前状态。

当前 OCR 修改先用 `get_ocr_result {includeVersion:true}` 读实际页的 `results[].version`，`save_ocr_result` 按页带 `expectedVersion`；REST 对等入口为 `/api/files/{id}/ocr-pages/{page}`。409 时重读核实，不覆盖新版。当前解析使用 `preflight_file_parse_result`（`kind=file` 或 `kind=ocr`；OCR 带实际读过的 `pages:[{page,version}]`）冻结输入，再用 `commit_file_parse_result` 带原 `inputRef`、独立 `expectedVersion`、全部 `parts`、`idempotencyKey/actor/reason` 提交；HTTP 为 `/api/files/{id}/parse-result/preflight`、`/commit`、`/history`，审计 MCP 为 `get_file_parse_history`。输入或输出版本冲突须重读/重新预检，不能换用兼容写口绕过。旧 `save_parse_result` 保留兼容载荷和状态更正；历史缺血缘记 unknown。交接同时保留采用的文件/页版本及解析输入引用，不以所选页成功声称全文件完成。

## 纠偏与核验

1. 把 OCR 文字解析为企业行，每行保留准确源文件和页码。
2. 匹配三张当前导出快照。有效信用代码是强匹配键；现名、已确认别名用于发现候选。保留已匹配、未匹配和有歧义的全部行。
3. 每条正式名单行回到出处页视觉核验，包括文字、代码、行边界和页码。OCR 只缩小检查范围，不替代来源核验。
4. 转录只能改成来源页支持的内容；事件元数据和企业身份不与页级纠偏混同。
5. 称号、事件类型、年度和批次取自公布正文及附件。平台申请/维护字段不能确立正式事件年度或批次，参见[业务规则](./decisions.md)。
6. 信用代码缺失时遵循[身份查证说明](./uscc-recovery.md)；缺代码的正式行仍可按身份待核入库。

### 同份通知含新认定与复核

按附件、名单段分别核实，不把通知标题中的新认定年度/批次套到复核行。每段交接必须逐字段列出依据：

- `eventType`：认定或复核，依据该附件/名单段的正文；“复核通过名单”不是新认定。
- `year`：认定事件的认定年；复核事件的**原认定年**。复核名单仅写结论年时，回到正文引用的复核工作通知、原认定通知和该企业原行核实；不能用“首次认定年”或减三年来代填。
- `decidedYear` 与 `reviewOutcome`：分别记录正式公布的结论年和通过/不通过。未知填 `null`，不能从平台终审状态补出正式结论。
- `batchSeq`：复核所对应的原认定批次；文件只写年度、没有批次数字时留 `null`。新认定的“第二批”、平台 `whpc` 的后缀和“该年只找到一份名单”都不能证明复核的原批次。

交接表同时保留文件哈希、正文/附件页码、名单序号和企业身份依据。解析器若只输出 `year/seq`、不携带 `decidedYear/reviewOutcome`，其结果不能直接作为完整事件载荷；先补齐这份字段级交接，再使用统一应用 API。未知值仍可保留入库，但必须列为尚未解决的事实缺口。

更正后分别读回事件及当前资格；生命周期 `dueYear` 延后不等于当前资格已为 `eligible`。按现行规则仍因批次、结论或出处待核时，保留原查询/导出失败与具体门槛，不填造批次或改变资格规则完成验收。

## 按当前应用契约写入

写入前查看运行中应用的 `/_openapi.json` 或 MCP `tools/list`；以当前结构和[名录生命周期契约](../../../../lib/roster-import-client.ts)为载荷依据。

首次变更前确认目标应用/数据库及其基线或可恢复备份，备份放在 Git 外。目标或恢复点无法确认时，停在写入之前。

- TUS 负责传输，再调用应用文件注册、页图、OCR 和解析接口。`record_evidence.source_file` 必须是已入文件库文件的相对路径。
- 企业名录和支持的平台证据通过统一导入写入：HTTP `POST /api/roster/import/preflight` 后 `/commit`，或 MCP `preflight_roster_batch` 后 `save_roster_batch`。同批保留一个来源身份、哈希和幂等键。
- 正式公布原行按[正式事实写入契约](../../../../server/utils/official-evidence.ts)提供 `evidence.publishedRow`，逐字保存本次已核原名、代码、属地及声明、文件和行坐标；未知字段显式为 `null`。普通公告载荷兼容旧协议，其成功不表示已捕获公布原行。既有事件缺少该表示时，按同契约的精确更正流程固定 evidence ID、版本和 `planHash` 补核，再用 `official=latest` 独立读回；保留原事件和出处 ID。
- 按[平台查询说明](./platform-query.md)通过应用 REST/MCP 查证三类平台来源。查询结果是只读证据候选，不自动写入。完整范围查询才可证明零记录；全部关系和原查询时间均保留。存储支持 `business_list`（businessList）、`apply_list`（queryList）及独立的 `recognized_list`（queryBusList）。原结果/每个批量分段只通过统一预检、提交转存，随后读回全部查询/行 ID，遵循[归档转存契约](../../../../lib/platform/recognized-evidence.ts)。缺原始时间或分页证明时留待处理，不改标来源。
- 公开来源和平台证据只使用当前契约支持的载荷。公开来源补码、合并结构见当前 API；遵循[身份查证说明](./uscc-recovery.md)中更严格的 `cross_source` 准入条件。
- 同批提交具有原子性：失败不写业务行。不得改用直接 SQLite 写入或临时导入器。结果不确定时按[同键恢复流程](./orchestration.md)处理。

提交后精确读回：`GET /api/roster/evidence/{id}` / `get_roster_evidence` 可选 `official=latest|history`，`GET /api/roster/events/{id}` / `get_official_event` 可选 `official=latest`；按当前 discovery 核对鉴权和分页，区分原始出处、当前正式值与别名。历史用 `beforeRevision`，事件列表用 `afterEvidenceId`，`pageSize` 默认20/最大50，`maxBytes` 默认16384/最大65536。需要当次不可变快照时，用 `/api/roster/import/receipts/items` / `list_roster_import_items` 的 `projection=snapshot|eventIds`，显式选 `source=private_batch` + `batchId` 或 `source=redacted_receipt` + `receiptId`，并固定 `itemIndex/oldRecordId`；eventIds 单独 cursor 分页。缺失、unavailable、not_retained 原样报告，不从当前详情重建或换源补齐。仍须由独立读取者确认字段和固定版本，回执成功本身不完成业务确认。

### 更正既有事件与出处（#34）

统一导入不负责修改既有 `record_event`。先检查运行中契约，而不是根据 #34 是否关闭判断能力：当前已有 `GET /api/roster/events/{id}`、`POST /api/roster/events/corrections/preflight`、`/commit` 和 `GET /api/roster/events/{id}/audit`，MCP 对应 `get_official_event`、`preflight_event_corrections`、`commit_event_corrections`、`get_event_correction_audit`。

发现事件字段错误时，先按稳定 ID 读回 `event/record/evidence/files`；记录 `eventId/recordId/enterpriseId/expectedRevision`、文件哈希、字段级旧值/新值及每项原页依据。冻结 `idempotencyKey/sourceIdentity/actor/basis/operations[].patch`，预检后逐项核对 `before/after/evidence/files/impact`；提交原请求及其 `planHash`。字段省略表示保留、`null` 表示未知；不支持的字段不能混入 patch。版本、来源或计划冲突时停下重新核实；结果不确定时保持同键恢复。

提交后按原 ID 读回、检查追加审计及原出处，核对企业/记录/事件/出处数量未增加，再验证资格、查询和导出。支持的更正不需要等待 #34；实际契约不支持的字段才记入 #34 或窄票并保留待处理。不得换幂等键重导创建替代事件，不得直接 SQL 修改。`attachment/listNo/sourceFile` 属于出处更正，按当前独立出处更正契约处理，不能塞进事件更正。

既有 `POST /api/roster/evidence/pages`（当前 API）仅用于已核实的 PDF 实际页码更正，只改 `page`，不能改事件元数据、`attachment`、`listNo`。请求按文件库相对 `sourceFile`、`listNo` 及 `enterpriseId` 或 `enterpriseName` 唯一定位，并带 `basis`。先用 `dryRun: true` 提交原条目，核对返回 `evidenceId`、`previous` 和来源页，再对同一已确认条目以 `dryRun: false` 应用并核验响应。接口不支持预期旧值前置条件，目标或当前值可能变化时须重做预演；定位不唯一或页码无法确认时保留待核。页码接口不能当通用更正 API。

入库后查询 `GET /api/roster/import/duplicate-candidates?batchKey=…`（当前 API）。没有当前契约支持的平台关系证据的同名候选继续待核，不按名称直接合并。

## 完成报告

本轮涉及补码、身份归并、查询或快照变化时，先完成[旧解释复核](difference-investigation.md#新证据后的旧解释复核)，将影响清单及尚未复核项纳入交接。

分别报告输入/应入库文件、重复文件、转图页、OCR 成败、正式名单行、视觉核验、导出匹配、事件、身份查证、提交批次和 API 错误的数量与状态。文件/元数据、页图/OCR、事件元数据、身份和写入状态分开。OCR 完成不等于入库完成，缺代码不等于缺正式名单行。

正式文件的已知事实入库完成验收必须执行[文件交接事实对账](../../../../scripts/verify-roster-source-completeness.mjs)：原页独立清单包含全部行及已知字段，使用未裁剪的实际事件 GET 读回运行 `scripts/verify-roster-source-completeness.mjs`。保存输入哈希、读回时间、目标身份、工具版本、退出码和报告。退出非零不得标记已知事实入库完成；unknown 清单仍随交接保留。此检查不改变 `parsed` 的文件段语义，也不能用预检载荷、提交计数或原文非空替代。
