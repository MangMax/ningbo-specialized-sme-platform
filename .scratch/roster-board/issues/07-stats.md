# 07 — 统计概览

**What to build:** 一个概览视图:按称号、按区县、按年份(认定/复核)、按来源计数,让经办人一眼看全局并能快速汇报。

**Blocked by:** 04 — 事件类型与批次:认定 / 复核 / 入库培育(可多条)

**Status:** ✅ done(2026-10-13)

- [x] `GET /api/stats` 返回计数聚合
- [x] 概览页:称号分布、来源对比、事件类型分布、区县 Top 20、年份趋势
- [x] 称号/来源/区县可点击下钻到台账(`/?title=&source=&district=`),`pages/index.vue` 已支持读初值
- [x] 事件类型/年份下钻 — **原票面写法已过期，实际已实现**：`pages/stats.vue` 的事件类型、年份条分别 `drillTo('eventType', …)` / `drillTo('year', …)`（约 211 / 266 行）；台账页 `pages/index.vue` 读 `route.query.eventType` / `route.query.year` 初值（84–85、128–129 行）；`lib/query.ts` 的 `buildWhere` → `buildEventExists`（125–130 行）按 `record_event.event_type` / `year` 真实筛选。**未新增功能，仅更正旧框**。
- [x] 图表无新依赖,沿用 `--primary` 单色条
