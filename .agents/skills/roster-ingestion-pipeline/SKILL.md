---
name: roster-ingestion-pipeline
description: '用于本应用的宁波专精特新名录清洗与入库：分类源文件、将 PDF 逐页转图并 OCR、校验纠正完整名单、补充企业身份依据、采集平台证据、判断称号差异，并通过应用 API/MCP 提交代理确认的结论。'
---

# 名录清洗与入库

适用于名录文件处理、平台证据采集、企业身份查证和称号差异判断。完整保留正式名单；采集、入库与业务判断分别记录结果。

## 选择工作流程

- **文件处理**：遵循[文件到名录的流程](references/workflow.md)。区分正式公布与平台快照；按 `lib/file-store-scope.ts`、`files/README.md` 处理重复文件和入库范围。PDF 每页先转图再 OCR，办公文档直接解析文字。每份文件就绪即交接纠偏，不等待其他文件；所有正式名单行均须回到来源页视觉核验，包括已匹配导出的行。
- **身份缺失**：遵循[信用代码补全与身份查证](references/uscc-recovery.md)。跨平台和公开来源搜索企业名称、关键词；候选须有证据链才能确认。信用代码缺失不阻止正式名单行入库。
- **平台采集**：先查看 `GET /api/platform/capabilities` 或 MCP `get_platform_capabilities`，再按[平台查询说明](references/platform-query.md)使用应用 REST/MCP 单条或批量查询。保留全部关系、分页和未完成范围。凭据由服务端管理；代理不得读取 Cookie 或直调平台网址。
- **差异、待审核与全量刷新**：遵循[差异调查与判断](references/difference-investigation.md)。先对应具体认定事件和平台流程，再判断是否有差异；名称出现地名变化或属地冲突时，进入其中的“地名变化与迁移查证”，主动搜索名称沿革及迁入迁出。仅凭历年公布与最新导出集合不同，不能认定业务差异。在用户限定范围内复用归档证据。代理判断原因与措施，软件保存查询事实和明确决定；可用[合成判断示例](references/adjudication-examples.md)核对理解。

## 编排与写入

按[多代理编排](references/orchestration.md)交接、确认完成和恢复失败：同一企业跨文件、跨称号只设一名负责人；最多两名调查代理，平台请求全进程最多并发两个，业务写入者只设一名。工作代理不继续拆派。复用已完成证据，只补缺口。

写入前查看当前 OpenAPI 或 MCP `tools/list`。通过统一应用 API/MCP 预检、提交和读回，禁止直接写 SQLite；重试保持幂等键。`queryBusList` 明确按 `recognized_list` 入库，按[平台查询说明](references/platform-query.md)保留分段、时间和页码并核对 ID。不支持的写入留待处理，不伪造来源类型绕过校验。

[业务规则](references/decisions.md)定义事件和来源语义；载荷以仓库 `docs/roster-lifecycle-contract.md` 为准。正式公布确立称号历史，导出表代表平台快照。未匹配平台的正式行仍须保留，未知字段留空。issue #35 中的企业名称只是查证线索，不是已确认的身份依据。

业务数据库、源文件、上传文件、凭据和个案证据保存在 Git 外。文件/页图/OCR、正式事件、身份、查询覆盖、入库回执和业务判断分开报告。
