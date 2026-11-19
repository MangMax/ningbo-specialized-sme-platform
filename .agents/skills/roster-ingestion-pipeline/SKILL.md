---
name: roster-ingestion-pipeline
description: '用于本应用的宁波专精特新名录清洗与入库：分类源文件、将 PDF 逐页转图并 OCR、校验纠正完整名单、补充企业身份依据、采集平台证据、判断称号差异，并通过应用 API/MCP 提交代理确认的结论。'
---

# 名录清洗与入库

适用于名录文件处理、平台证据采集、企业身份查证和称号差异判断。完整保留正式名单；采集、入库与业务判断分别记录结果。

## 选择工作流程

- **文件处理**：遵循[文件到名录的流程](references/workflow.md)。区分正式公布与平台快照；按 `layers/sme-roster/lib/sme-roster/file-store-scope.ts` 处理重复文件和入库范围。PDF 每页先转图再 OCR，办公文档直接解析文字。每份文件就绪即交接纠偏，不等待其他文件；所有正式名单行均须回到来源页视觉核验，包括已匹配导出的行。
- **身份缺失**：遵循[信用代码补全与身份查证](references/uscc-recovery.md)。跨平台和公开来源搜索企业名称、关键词；候选须有证据链才能确认。信用代码缺失不阻止正式名单行入库。
- **平台采集**：先查看 `GET /api/platform/capabilities` 或 MCP `get_platform_capabilities`，再按[平台查询说明](references/platform-query.md)使用应用 REST/MCP 单条或批量查询。保留全部关系、分页和未完成范围。凭据由服务端管理；代理不得读取 Cookie 或直调平台网址。
- **差异、待审核与全量刷新**：遵循[差异调查与判断](references/difference-investigation.md)。先对应具体认定事件和平台流程，再判断是否有差异；名称出现地名变化或属地冲突时，进入其中的“地名变化与迁移查证”，主动搜索名称沿革及迁入迁出。仅凭历年公布与最新导出集合不同，不能认定业务差异。在用户限定范围内复用归档证据。代理判断原因与措施，软件保存查询事实和明确决定；可用[合成判断示例](references/adjudication-examples.md)核对理解。

- **有效名单对比与业务情况表**：沿用[差异调查与判断](references/difference-investigation.md#业务情况表与问题闭环)；收到业主修订终版、跨称号规则变化或需要另做一个称号时，先按[业务工作簿交付](references/business-workbook.md)核对最新模板、成员调整、期间与分组。固定双方快照、称号、判断时点和当前确认规则，重新生成双向差集；技术底稿独立追溯。

- **主体事实与解释引用**：查证迁入、迁出、注销/登记状态，确认、更正、撤回事实，或核对历史解释所引用的多个事实时，遵循[主体事实公开协议](references/enterprise-facts.md)。逐条固定 enterpriseId/factId/revision/kind；读回来源与审计后独立确认，旧解释不随事实 head 漂移。

## 编排与写入

**接到整批任务时，先读[负载编排](references/orchestration.md)，再开始各阶段处理。**未被分配具体工作片的执行者就是本批协调者，即使它本身是子代理。协调者按规模、证据体积、工具额度和当前资源决定直接处理或使用有界工作者池；任务数、每片大小和活跃代理数分别控制。所有阶段共享资源预算，同一企业跨文件、跨称号一名负责人。收到具体工作片的代理不继续拆派。复用已完成证据，只补缺口。

补码、身份归并、新增查询或更新快照后，执行[代理判断与覆盖写回](references/difference-investigation.md#默认待核代理判断与覆盖写回)，核对企业、称号和证据变化，判不出记录已查范围与缺口交人工通过代理处理。

写入前查看当前 OpenAPI 或 MCP `tools/list`。差异结论使用既有差异原因公开协议，读回核对；入库按统一应用 API/MCP 预检、提交和读回，禁止直接写 SQLite；重试保持其幂等键。`queryBusList` 明确按 `recognized_list` 入库，按[平台查询说明](references/platform-query.md)保留分段、时间和页码并核对 ID。不支持的写入留待处理，不伪造来源类型绕过校验。

[业务规则](references/decisions.md)定义事件和来源语义；载荷以仓库 `layers/sme-roster/lib/roster-import-client.ts` 为准。正式公布确立称号历史，导出表代表平台快照。未匹配平台的正式行仍须保留，未知字段留空。issue #35 中的企业名称只是查证线索，不是已确认的身份依据。

业务数据库、源文件、上传文件、凭据和个案证据保存在 Git 外。文件/页图/OCR、正式事件、身份、查询覆盖、入库回执和业务判断分开报告。

排查运行故障时，用已授权的 `GET /api/logs` 或 MCP `list_runtime_logs`，按 `module=sme-roster` 与已知的 `requestId` 或 `taskId` 缩小范围。PDF 转图、文件管理和 OCR 使用 `module=core`。需要查看未标注的历史记录时传 `module=:unlabeled`。业务结果仍以回执和审计读回为准。

## 新流程与旧数据边界（#484）

先备份数据库，再用 `difference_snapshot` / `POST /api/roster/difference-snapshots` 采集三接口。可选 `enterpriseIds` 限定公布企业；省略为全部。按接口原编号更新已有业务记录，缺少则新增，保存全部业务字段和类型；采集任务不保存请求参数原文、响应正文或 HTML。同一任务重试只恢复未完成范围。

采集后，由用户点击企业列表“刷新本页差异”，或调用 `POST /api/roster/differences/refresh` / `refresh_enterprise_differences`，可选 `enterpriseIds`。刷新复用已有比较逻辑，默认待核；相同业务输入保留已有结果与判断。用户要求筛除无差异时由代理判断，其余交代理与人工处理。程序不编排代理判断。

当前有效资格按[业务规则](references/decisions.md#当前有效资格)计算：公布优先，缺少适用公布依据时依次使用认定目录、关联办理、申报记录；高梯度向下计入，完整的已确认注销/吊销、迁出事实仍排除。正常平台资格不经过人工迁入确认或差异审批。旧评估版本、差异决定及回执保留历史语义，不作为当前资格的准入门槛。
