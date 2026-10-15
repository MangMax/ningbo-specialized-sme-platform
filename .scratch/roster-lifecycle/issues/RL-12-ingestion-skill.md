# RL-12 — 仓库自有清理入库技能

- **级别**：`scope:S`（仓库内工作流文档）
- **优先级**：P1
- **难度**：低｜**主要难点**：准确记录当前 API 能力与待补的名单写入缺口｜**建议模型**：magpie + DeepSeek
- **状态**：done（2026-10-15 新增）
- **交付**：[`../../../.agents/skills/roster-ingestion-pipeline/SKILL.md`](../../../.agents/skills/roster-ingestion-pipeline/SKILL.md)

**为什么现在做**：这次入库暴露出 OCR 完成与清理、纠偏、入库边界容易混淆，需要让后续代理从 app 工作目录即可执行同一流程。**风险**：skill 可能落后于 API 契约；每次写入前先发现当前 OpenAPI/MCP 工具，缺少名单写入口时回到 RL-11。

## 验收

- app 根目录可发现和触发；包括文件判别、PDF 转图、并行 OCR、逐文件接力、OCR 与三张导出表匹配、页码视觉校验、纠偏补缺和完整名单写入。
- 说明 API 写入契约和当前名单写入 API 缺口；不把直接 SQLite/导入器说成统一 API。
- 明确所有公布名单条目均保留；未匹配项进入待核对列表而非丢弃。
- 不在文件中保存 token/cookie；文件和运行证据可追溯。
