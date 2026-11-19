/**
 * 「生产环境要藏掉的 Nitro 内建 OpenAPI 路径」的**纯判据**(票 19)。
 *
 * 抽出来单独放,是因为中间件(`server/middleware/openapi-prod-guard.ts`)要 import h3,
 * 而裸 node 的 vitest 进程解析不到 h3(见 `server/utils/api-auth.ts` 顶部的说明)。
 * 判据本身是纯的,放这里就能单测;中间件只剩「读路径 → 问这里 → 抛 404」三行。
 */

/**
 * 要藏的三条**确切**路径:
 *  - `/_openapi.json` —— spec 本体(给代理读的);
 *  - `/_scalar` / `/_swagger` —— 两个 UI(nitro 对同一份 spec 的两种渲染)。
 *
 * 用 `Set` 做**精确匹配**而不是前缀/通配:SPA 里真有一页叫 `/_scalars` 之类也不该被误伤。
 */
export const OPENAPI_PATHS: readonly string[] = ['/_openapi.json', '/_scalar', '/_swagger']

const LOOKUP = new Set(OPENAPI_PATHS)

/**
 * 这条路径在生产环境是否应当回 404。
 *
 * 开发环境一律 `false` —— 那些端点存在的意义就是开发时给人看文档与给代理发现接口。
 */
export function shouldHideOpenApiPath(pathname: string, opts: { dev: boolean }): boolean {
  if (opts.dev) return false
  return LOOKUP.has(pathname)
}
