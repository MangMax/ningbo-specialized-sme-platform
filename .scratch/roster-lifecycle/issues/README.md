# 名录生命周期与清理流程 — 票据

本目录是 app 本地票据集；当前 app checkout 没有配置 Git remote，T3 项目也未绑定 GitHub 仓库，因此这些票据暂记在仓库 `.scratch`，未创建外部 GitHub Issue。

| ID | 优先级 | 难度 | 标题 | 依赖 | 状态 |
|---|---|---|---|---|---|
| RL-01 | P0 | XL / 架构 Spike | 对比与生命周期数据模型决策 | — | ready |
| RL-02 | P0 | M | 导入经信局历年小巨人工作簿 | RL-01 | ready |
| RL-03 | P0 | L | 平台双接口关联与别名匹配证据 | RL-01 | ready |
| RL-04 | P0 | L | 跨称号去重企业总表及差异原因 | RL-01, RL-03 | ready |
| RL-05 | P0 | M | 三张平台导出表建模为年度对照快照 | RL-01 | ready |
| RL-06 | P1 | M | 本批缺信用代码企业联网补查 | RL-11 | ready |
| RL-07 | P1 | L | 年度增量更新与平台迁出删除 | RL-04, RL-05, RL-11 | ready |
| RL-08 | P1 | M | 首次认定标注与筛选 | RL-01, RL-04 | ready |
| RL-09 | P1 | M | 下一年度复核企业清单 | RL-01, RL-04 | ready |
| RL-10 | P1 | M | 出处页码与预览跳转 | RL-11 | ready |
| RL-11 | P1 | L | 统一名单数据 API 写入路径 | RL-01 | ready |
| RL-12 | P1 | S | 仓库自有清理入库技能 | — | done (本次新增) |
| RL-13 | P2 | S / Spike | TUS 文件标识、命名与重命名策略 | RL-11 | ready |

## 建议执行顺序

1. RL-01 决定最小数据模型；RL-02 可同时导入已存在的第 1–7 批源数据并报告第 8 批缺口。
2. 并行完成 RL-03、RL-05；随后以 RL-04 形成一企一行、称号/事件多条的统一视图。
3. 补齐 RL-11 后推进年度增量和本批信用代码补查；RL-08/09/10 直接消费已定的历史事件和证据模型。
4. RL-12 技能已加入 app；RL-13 排在主要对比与名单使用功能之后。

## 难度约定

- **S**：文档或单一边界决策；**M**：一个明确模块；**L**：跨 API、数据与界面但验收边界单一；**XL**：跨域模型/迁移，必须先有 ADR 并拆分实现票。
- **P0**：影响当前对比正确性或基础数据完整性；**P1**：用户高频能力及清理自动化；**P2**：文件运维体验等后续事项。

## 票据

- [RL-01 对比与生命周期数据模型决策](RL-01-domain-model.md)
- [RL-02 历年小巨人工作簿](RL-02-little-giant-history.md)
- [RL-03 平台双接口关联与别名匹配](RL-03-platform-identity.md)
- [RL-04 跨称号去重企业总表及原因](RL-04-unified-roster.md)
- [RL-05 三张导出表年度快照](RL-05-export-snapshots.md)
- [RL-06 本批缺信用代码补查](RL-06-uscc-research.md)
- [RL-07 年度增量更新](RL-07-annual-delta.md)
- [RL-08 首次认定](RL-08-first-recognition.md)
- [RL-09 下一年复核清单](RL-09-next-review.md)
- [RL-10 出处页码与预览跳转](RL-10-page-provenance.md)
- [RL-11 统一名单 API](RL-11-api-ingestion.md)
- [RL-12 清理入库技能](RL-12-ingestion-skill.md)
- [RL-13 TUS 文件命名与重命名](RL-13-tus-naming.md)
