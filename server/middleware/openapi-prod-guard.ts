import { shouldHideOpenApiPath } from '../utils/openapi-guard'

/**
 * 生产环境**藏掉 Nitro 内建的 OpenAPI 端点**(票 19)。
 *
 * ── 为什么还需要这个中间件 ──────────────────────────────────────────────
 * nitro 自己已经做到了「不注册」:`resolveOpenAPIOptions` 的第一条判据就是
 * `if (!dev && !openAPI.production) return` —— 所以生产构建里 `/_openapi.json`
 * 与 `/_scalar` **根本不进路由表**,`nuxt.config.ts` 里也刻意不设 `production`。
 *
 * 但「不注册」在这个 app 上的**可观测结果不是 404**:本仓是 `ssr: false` 的 SPA,
 * 未匹配的路径会落到 Nuxt 的 SPA 兜底,回一张 `index.html`(200)。于是
 * `curl /_openapi.json` 得到的是 200 + 一坨 HTML —— spec **确实没有暴露**
 * (没有 JSON、没有接口清单),可「这里没有这个东西」这个信号是**模糊**的:
 * 代理会以为拿到了什么,再花一次去解析 HTML。
 *
 * 票 19 的验收写的是「生产构建下 OpenAPI 端点**不暴露**(实测 404)」。
 * 所以这里把意图**写死**:生产环境下这三条路径明确回 404。这不是第二道安全防线
 * (spec 本来就没注册),而是把「没有」这件事说清楚。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 * - **只在生产**生效(`import.meta.dev` 为真时直接放行),开发环境照旧能开
 *   `/_scalar` 看文档 —— 那是这个端点存在的意义。
 * - 名单在 `server/utils/openapi-guard.ts`(**纯判据**,可单测)。
 * - **不改 nitro 的默认**:哪天要在生产开 OpenAPI,得同时改 `nuxt.config.ts`
 *   的 `openAPI.production` **和**那份名单 —— 两处都动过一遍,不会误开。
 *   (见 `.env.example` 里那条警告。)
 */
export default defineEventHandler((event) => {
  if (!shouldHideOpenApiPath(getRequestURL(event).pathname, { dev: import.meta.dev })) return
  throw createError({ statusCode: 404, message: 'Not Found' })
})
