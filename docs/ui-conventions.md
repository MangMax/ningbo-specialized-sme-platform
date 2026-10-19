# UI conventions

For Vue pages and components:

- Reuse `TablePagination`, `TableLoadingStatus`, `TableFailureState`, `TableHoverCardContent`, `PageHeader`, and the existing `data-table` primitives. Shared components and tokens own sizing; avoid parallel page-specific pixel rules.
- Keep loading layout stable. When a request fails after a successful result, retain that result with its source page, explain the failed target, provide an explicit retry, and keep pagination at the bottom. Keep narrow screens readable and operable.
- Prefer Vue Composition API with TypeScript and the existing shadcn-vue components. Use `vue-best-practices` and `shadcn-vue` for Vue work; use `oil-ui` when a visual design choice needs review.
- Manually operate the affected page at desktop and 390px widths. Routine UI changes do not require a new visual review loop, a full-site geometry sweep, or pixel/frame assertions; preserve focused tests for API and interaction behavior.

## Enterprise detail and verification surfaces

- 企业详情默认展示「认定信息与记录」；「称号核对」是第二个 tab。不要把核对矩阵放回首屏，也不要在顶部再加一张结论状态卡。
- 侧边企业抽屉只保留事实、称号历史、差异摘要和进入企业详情核对的入口；不重复核对矩阵或平台记录表。
- 这些区域不使用彩色单侧边线、节点/连线等装饰；普通分隔线用 `border`，不要让它读成装饰。
- 折叠与选择使用现有的 `DisclosurePanel`（Accordion）、`Select`、`Tabs`、`Sheet`；这些页面不新增原生 `details` / `summary` / `select` 或手写折叠。
