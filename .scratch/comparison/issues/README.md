# 两侧名录比对 — 工单

来自 [SPEC.md](../SPEC.md)。前沿 = 阻塞项已完成的票。

| # | 标题 | Blocked by | 状态 |
|---|---|---|---|
| 01 | 比对口径与计算纯函数(`lib/comparison.ts` + 测试) | — | ✅ done |
| 02 | Nitro 接口 `GET /api/comparison` | 01 | ✅ done |
| 03 | 比对页面 `/comparison` + 侧栏入口 + 导出 | 02 | ✅ done(真实漂移徽标验收受数据字段缺失阻塞,见票 03) |
| 04 | 人工标注 `curated`(JSON 落盘 + PATCH + 页面开关) | 02 | ✅ done |

**前沿**:无 —— 01–04 实施已完成;人工标注验证记录见票 04。票 03 的真实城市/登记状态字段验收缺口见该票验证记录。

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
