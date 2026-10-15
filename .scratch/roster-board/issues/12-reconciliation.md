# 12 — 两侧名录比对(应纳未纳 / 应出未出)

**Status:** ✅ 口径已定 → 拆为独立模块 `.scratch/comparison/`(2026-10-14)

## 结论:口径已定,见 [comparison/SPEC.md](../../comparison/SPEC.md)

原挂起理由(「口径待定」)已消除。口径以**用户 2026-10 的两份人工比对 Excel**(`市专比对.xlsx`、`创新型比对.xlsx`)为准,设计期已用当前库逐步反算复现:

- **判据 = 统代**(`uscc_norm`),同一法人不同写法靠经信局侧统代归一化,**不做名称回退**。
- **不限认定年份、不排除 `nurture`(入库培育)** —— 复现依据:市专 **337 / 13**、创新型 **543 / 28**,与用户 Excel 抽样一致;排除 nurture-only 会掉到 122,对不上。
- **不限城市**:漂移 / 注销照常计入,只**标注**。
- **单位 = 企业 × 称号**;**小巨人恒空**(经信局无此来源)。
- 附一个**双向假阳性**真实案例(两来源统代不同的同一法人),已在 SPEC 记录:**不是 bug,是源数据统代错**,交 pipeline 导入侧归并。

## 交付

已拆为 4 张票(见 [comparison/issues/README.md](../../comparison/issues/README.md)):

> 以下 4 项**已迁移**到 `comparison/`，不在此票本地勾选（保留原状作历史去向）；括号内为各分票当前状态。

- [ ] 01 — 比对口径与计算纯函数（`comparison/01` → done）
- [ ] 02 — Nitro 接口 `GET /api/comparison`（`comparison/02` → done）
- [ ] 03 — 比对页面 `/comparison` + 侧栏入口 + 导出（`comparison/03` → 已完成页面/侧栏/导出；真实漂移徽标属数据边界）
- [ ] 04 — 人工标注 `curated`(范围可裁)（`comparison/04` → done）

> 本票不再本地跟踪,统一到 `comparison/`。
>
> **收口（2026-10-15，docs-only）**：本票是**口径票 + 去向票**，实际交付落在 `comparison/`，故这 4 项保持未勾、指向上表。设计期复现计数 337/13、543/28 属**当时库**；现行终库为 170/30、318/37（`evidence/comparison-regression/snapshot-counts.json`），**未在终库重算该口径的旧数字**，也不追改。
