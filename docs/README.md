# 文档导航

[项目说明与本地运行](../README.md) · [业务词表](../GLOSSARY.md)

## 当前契约入口

按要修改的业务选择入口，并阅读文中的适用范围、后续增量和兼容说明。总览有固定基线与待评审目标，不代表所有目标已实现；生命周期旧协议不能覆盖后续专用契约。

| 要了解的内容 | 入口与阅读边界 |
| --- | --- |
| 企业、记录、正式事实与平台业务的职责 | [数据模型总览](data-model.md)：区分已实现边界与待评审目标，术语以业务词表为准 |
| 名录生命周期与统一入库 | [名录生命周期契约](roster-lifecycle-contract.md)：REST 写入见 §8，MCP 见 §9；同时阅读后续增量 |
| 平台业务身份、内容版本与采集观察 | [平台业务记录契约](platform-business-record-contract.md)：各接口身份隔离，保留原观察与引用 |
| 文件元数据、显示名、移出与恢复 | [文件维护契约](maintenance-104.md)：区分 legacy 与 versioned 命令，核对修订、鉴权与恢复边界 |
| 后台任务查询、取消、重试与导出 | [任务中心契约](task-center.md)：按任务公开能力操作，任务完成不等于业务判断完成 |

## 操作与决策

- [部署、备份与回滚](../DEPLOYMENT.md)、[OCR 凭据配置](credential-settings.md)、[名录清洗与入库技能](../.agents/skills/roster-ingestion-pipeline/SKILL.md)。
- [架构决策记录](adr/)：先看每篇的状态和替代说明。例如[项目外入库 ADR](adr/2026-10-13-ingestion-is-outside-the-app.md)的 app 只读描述已被替代；[分域 ADR](adr/0001-source-domain-boundaries.md)标为 proposed；[正文共享 ADR](adr/2026-10-24-platform-archive-body-sharing.md)已停止继续实施。不能把这些状态解读为当前迁移已完成。

## 历史规格与验收证据

以下材料用于追溯当时的目标、交付与诊断，不是当前实现的统一依据。契约页内的旧验收章节同样受其日期、源码版本和执行范围限制；历史 FAIL、UNKNOWN、未运行项及外部日志路径按原记录保留，后来的通过不抹去它们。

- [名录生命周期路线图与旧票据](../.scratch/roster-lifecycle/SPEC.md)：保留阶段目标与拆票背景。
- [文件/OCR 入库管线规格](../.scratch/ingest-pipeline/SPEC.md)：保留早期设计及交付背景。
- [Vite Doctor 首次体检回执（2026-10-22）](reports/vite-doctor-2026-10-22.md)：保留当时诊断、失败与证据定位，不作为当前版本的检查结果。
