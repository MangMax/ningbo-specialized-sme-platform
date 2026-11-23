---
name: roster-workbook-delivery
description: '用于本应用的业务工作簿交付与修订验收：按当前资格规则生成有效名单与双向差集，执行两版成员与原因对账、版式属性检查和原生值修改边界校验。'
---

# 业务工作簿交付与验收

适用于整理有效名单工作簿、接收人工修订终版、将交付口径复用于其他称号，以及交付前的成员对账、版式检查和原生值校验。

## 能力导航

- **工作簿交付流程与口径**：遵循 [业务工作簿交付](references/business-workbook.md)，冻结基准终版、生成称号有效集合、核对期间与接口信息并完成分流验收。
- **两版成员与原因对账**：使用 [成员与原因对账](references/report-reconciliation.md) 与只读脚本 [reconcile-roster-reports.py](scripts/reconcile-roster-reports.py)，按稳定标识比较新增、移除、保留与名称变化。
- **版式与静态交付属性检查**：使用 [工作簿交付属性检查](references/workbook-layout-check.md) 与只读脚本 [check-workbook-layout.py](scripts/check-workbook-layout.py)，核对表头、行数、字体、行高、冻结与筛选范围。
- **修订前后原生值与修改边界校验**：使用 [工作簿修订的值与修改边界](references/workbook-value-check.md) 与只读脚本 [compare-workbook-values.py](scripts/compare-workbook-values.py)，验证仅允许范围内的单元格与属性发生变化。

## 约束

- 业务工作簿、对账约定与验收回执一律保存在 Git 外；脚本只读输入且不得覆盖输入或历史回执。
- 资格规则以 [名录清洗业务规则](../roster-ingestion-pipeline/references/decisions.md) 为单一来源；差异调查与平台查证走 [roster-ingestion-pipeline](../roster-ingestion-pipeline/SKILL.md)。
- 机器检查通过只证明声明范围内的静态约束，不代替业务判断或长文本人工抽查。
