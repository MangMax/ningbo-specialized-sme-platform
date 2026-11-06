> **历史阶段说明（#591）**：下文保留 2026-10-14/15 阶段材料及验收记录。本地草稿不是当前 published tracker；当前工单见 [GitHub Issues](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/591)，使用规则见[仓库 tracker 规范](../../../docs/agents/issue-tracker.md)。原文中的完成状态、数字及成功/失败记录仅对应当时输入，本次文档注记不构成重跑或当前运行保证。
> 下方“全部完成”仅指历史交付范围。后继入口分别见[历史差集读取契约](../../../docs/comparison-summary-contract.md)、[差异决定与旧标注兼容](../../../docs/maintenance-102.md)和 [#22 继承验收说明](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/22#issuecomment-6262788708)；不代表当前功能、性能或母票全部验收完成。
>
> **验收输入分界**：[UI-ACCEPTANCE](../UI-ACCEPTANCE.md) 的非零标注等场景使用浏览器只读响应替身，未发送 PATCH；[04](04-curation.md) 则读取真实库、实际写入隔离 JSON 并验证 PATCH/UI，不是写真实本地标注文件；[03](03-comparison-page.md) 的真实漂移徽标验收未通过、checkbox 保持未勾，fixture 只证明渲染。三个事实分别成立，不能互相替代或合称真实数据全部 PASS。

# 两侧名录比对 — 工单

来自 [SPEC.md](../SPEC.md)。前沿 = 阻塞项已完成的票。

| # | 标题 | Blocked by | 状态 |
|---|---|---|---|
| 01 | 比对口径与计算纯函数(`lib/comparison.ts` + 测试) | — | ✅ done |
| 02 | Nitro 接口 `GET /api/comparison` | 01 | ✅ done |
| 03 | 比对页面 `/comparison` + 侧栏入口 + 导出 | 02 | ✅ done(真实漂移徽标验收受数据字段缺失阻塞,见票 03) |
| 04 | 人工标注 `curated`(JSON 落盘 + PATCH + 页面开关) | 02 | ✅ done |
| — | UI/UX 验收(oil-ui,验收到合格) | 03, 04 | ✅ 合格,见 [UI-ACCEPTANCE](../UI-ACCEPTANCE.md) |

**全部完成并已合入 `main`**(2026-10-14):01–04 实施 + oil-ui UI/UX 验收合格。真实库四个数字复现(市专 **337 / 13**、创新型 **543 / 28**、小巨人 **0 / 0**),126 测试 + typecheck 全绿。

**唯一保留的边界**:真实库中 `enterprise.city` 与 `reg_status` **全为空**(外部工商富化数据不入库),故「漂移 / 注销」标记与「已核实数」在真实数据上恒为空态 —— 其呈现以浏览器只读 fixture 验证,不宣称真实库已有这些字段。见 [UI-ACCEPTANCE](../UI-ACCEPTANCE.md)。

## 依赖图

```
01 计算层 ──► 02 接口 ──► 03 页面/导出
                     └──► 04 人工标注
```

## 口径速记(详见 SPEC)

- **判据 = 统代**;同一法人不同写法靠经信局侧统代归一化,**不做名称回退**。
- **不限年份、不排除 nurture**(含 2021 入库培育、含复核)。
- **不限宁波**:漂移/注销照常计入,只**标注**。
- 单位 = `(enterprise_id, title_code)`;**小巨人恒空**。
- 期望计数(设计期实测):市专 **337 / 13**,创新型 **543 / 28**。

## 给实现者的硬约束

- **UI 一律 shadcn-vue 官方组件**(用 `pnpm dlx shadcn-vue@latest add @shadcn/<name>` 拉),复用现有 `StatTile` / `DrillChip` / `TitleBadge` / `ExportButton`;**不得手写或使用原生 `<table>/<input>/<select>`**。
- **标签文案只从 `lib/labels.ts` 取**(`TITLES` / `SOURCES` / `EVENTS` / `QUALITY_FLAGS`),不要各写一份。
- 数据处理优先 **es-toolkit / 原生 ES6**(`groupBy` / `keyBy` / `partition` / `uniqBy`),不要手写大量判断循环。
- 页面取数用 **Pinia Colada `useQuery`** + `placeholderData: (previous) => previous`(切 tab 不闪回)。
- 票 01/02 提交分支:`feat/comparison-core`(按用户本次指令从干净 `main` 创建,覆盖旧分支约定);`git add` 只加本票文件,不提交无关未跟踪文件。

> 完成后:四张票的分支(`feat/comparison-{core,page,curation,ui-polish}`)均已快进合入 `main`。
