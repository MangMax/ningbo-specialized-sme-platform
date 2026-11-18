import type { H3Event } from 'h3'

/**
 * 写入 tool 的守卫(票 18)。
 *
 * 给每个写入 tool 的 `enabled` 用:`enabled: writeGuard`。
 *
 * 判据只有一条 —— 中间件(`server/mcp/index.ts`)折进 `event.context.mcpAuth` 的
 * `writeAuthorized`。未鉴权时该 tool **不出现在 `tools/list`**,也不可调用:
 * 「看不见」比「看得见但一调就报错」对代理更友好(它不会去试一条注定失败的路),
 * 而且不会把写入口的存在暴露给没有 token 的客户端。
 *
 * 这不是唯一防线 —— 中间件已经对未鉴权写入回了 HTTP 401。两道同判据,
 * 见 `server/utils/mcp-auth.ts` 顶部说明。
 */
export function writeGuard(event: H3Event): boolean {
  const auth = event.context.mcpAuth as { writeAuthorized?: boolean } | undefined
  return auth?.writeAuthorized === true
}
