# 01 — 项目脚手架与运行时打通

**What to build:** 一个可运行的 Nuxt SPA 空壳,已接好数据层与组件层,页面上能读到一条来自 SQLite 的记录(哪怕先是写死的种子) —— 证明 Nuxt + Drizzle + better-sqlite3 + shadcn-vue + Pinia Colada + VueUse 这条链在本地跑得通。

**Blocked by:** None — can start immediately.

**Status:** ✅ done(2026-10-13)

- [x] `pnpm` 初始化;Nuxt 关闭 SSR(`ssr: false`)
- [x] Drizzle + drizzle-kit + better-sqlite3 接好,能跑一次 migrate,生成 `data/*.db`
- [x] Tailwind + shadcn-vue 就绪,页面能渲染一个 shadcn 组件
- [x] Pinia Colada 接好,一个查询从 Nitro API route 取数并渲染
- [x] 所有依赖取当前最新稳定版并锁定
- [x] `pnpm dev` 起得来,首页显示来自库的一行数据

**验证**:`pnpm test` 3 passed · `pnpm typecheck` clean · `pnpm build` 成功 · 首页与 `/api/health` 实测通过。
**备注**:`vitest` 因供应链 release-age 策略钉在 `^4.1.11`(5.x 发布未满 24h);`pnpm` 的 `allowBuilds` 写在 `pnpm-workspace.yaml`。
