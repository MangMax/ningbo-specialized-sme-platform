# UI conventions

For Vue pages and components:

- Reuse `TablePagination`, `TableLoadingStatus`, `TableFailureState`, `TableHoverCardContent`, `PageHeader`, and the existing `data-table` primitives. Shared components and tokens own sizing; avoid parallel page-specific pixel rules.
- Keep loading layout stable. When a request fails after a successful result, retain that result with its source page, explain the failed target, provide an explicit retry, and keep pagination at the bottom. Keep narrow screens readable and operable.
- Prefer Vue Composition API with TypeScript and the existing shadcn-vue components. Use `vue-best-practices` and `shadcn-vue` for Vue work; use `oil-ui` when a visual design choice needs review.
- Manually operate the affected page at desktop and 390px widths. Routine UI changes do not require a new visual review loop, a full-site geometry sweep, or pixel/frame assertions; preserve focused tests for API and interaction behavior.
