---
name: roster-ingestion-pipeline
description: '用于本应用的宁波专精特新名录清洗与入库：分类源文件、将 PDF 逐页转图并 OCR、校验纠正完整名单、补充企业身份依据、采集平台证据、判断称号差异，并通过应用 API/MCP 提交代理确认的结论。'
---

# 名录清洗与入库

适用于正式公布名单处理、工信部平台证据采集、企业身份查证、主体事实与称号周期处置、以及称号差异调查。纯清单类文件请转用 [lead-list-ingestion](../lead-list-ingestion/SKILL.md)；业务工作簿交付与版式/对账验收请转用 [roster-workbook-delivery](../roster-workbook-delivery/SKILL.md)。

## 能力导航

- **文件到名录入库**：遵循 [文件到名录的流程](references/workflow.md)。按 [layers/sme-roster/lib/sme-roster/file-store-scope.ts](../../../layers/sme-roster/lib/sme-roster/file-store-scope.ts) 判定入库范围；PDF 逐页转图再 OCR，办公文档直接解析文字；所有正式名单行须回到来源页视觉核验，未匹配平台导出的正式行完整保留。
- **信用代码补全与身份查证**：遵循 [信用代码补全与身份查证](references/uscc-recovery.md)。跨本地、平台和公开来源查证并闭合证据链；信用代码缺失不阻塞正式名单行入库。
- **工信部平台采集**：先检查 `GET /api/platform/capabilities` 或 MCP `get_platform_capabilities`，再遵循 [平台查询说明](references/platform-query.md) 通过应用 REST/MCP 执行单查、批量查询或 `difference_snapshot` 三接口采集。凭据由服务端管理，代理不得读取 Cookie 或直调平台网址。
- **差异调查与判断**：遵循 [差异调查与判断](references/difference-investigation.md) 与 [合成判断示例](references/adjudication-examples.md)。先核对具体正式事件与平台流程，再判断原因与措施；名称出现地名变化或属地冲突时执行迁移查证。差异处置独立于当前有效资格。
- **主体事实与周期处置**：维护迁入、迁出、注销/登记状态及多事实解释引用时遵循 [主体事实公开协议](references/enterprise-facts.md)；维护小巨人周期处置及资格口径核对时遵循 [业务规则](references/decisions.md)。
- **批量负载编排**：接到整批文件或企业清单时，先读 [多代理编排](references/orchestration.md) 设定有界工作者池与共享资源预算，同一企业跨文件、跨称号由一名负责人处理。

## 写入、备份与排查边界

- **先看契约再写入**：写入前检查运行中应用的 `/_openapi.json` 或 MCP `tools/list`（载荷类型见 [roster-import-client.ts](../../../layers/sme-roster/lib/roster-import-client.ts)）。只读模式（`NUXT_DB_READONLY=1`）下禁止写入；所有写操作走应用 API/MCP 的预检、提交、读回并保留幂等键，禁止直接写数据库。
- **写前备份**：大批量写入或全量采集前，使用 PostgreSQL `pg_dump -Fc` 生成备份并校验 SHA-256，备份置于 Git 外。
- **隔离与日志排查**：业务数据库、源文件、上传文件、凭据和个案证据均保存在 Git 外。排查故障通过授权的 `GET /api/logs` 或 MCP `list_runtime_logs`，按 `module=sme-roster`（文件/PDF/OCR 用 `module=core`）与 `requestId` / `taskId` 缩小范围。
