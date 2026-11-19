import { createError, getHeader, setHeader, type H3Event } from 'h3'
import { readApiToken, resolveApiAuth, unauthorizedApiMessage } from './api-auth'

/**
 * `requireApiToken` —— 受保护的写口用的**守卫**(票 19)。形状照 `server/utils/mcp-guard.ts`。
 *
 * ── 为什么守卫单独一个文件,判据留在 `api-auth.ts` ────────────────────────
 * 与票 18 的 `mcp-auth.ts` / `mcp-guard.ts` 同一个分法:**判据**(头怎么读、怎么比、
 * 哪种没带)是纯函数,放 `api-auth.ts`,可单测;**贴到 h3 上**的那一层放这里。
 *
 * 这层薄壳不只是审美:本仓的 vitest 跑在裸 node 下,`h3` 在测试进程里**解析不到**
 * (它只挂在 `.pnpm/node_modules` 下、没有顶层入口)。把 h3 关在这个文件里,
 * `api-auth.ts` 就能被测试直接 import 而不炸 —— 而鉴权恰恰是那块最不能只靠手测的。
 */
export function requireApiToken(event: H3Event): void {
  const state = resolveApiAuth({
    given: readApiToken({
      authorization: headerOrUndefined(event, 'authorization'),
      'x-api-token': headerOrUndefined(event, 'x-api-token'),
    }),
    configured: useRuntimeConfig().apiToken,
  })
  if (state.writeAuthorized) return

  // 抛错而不是返回布尔:调用方(路由)在守卫失败后**没有任何合理的后续动作**,
  // 「返回布尔让路由记得判」只会多一处忘判的机会。
  //
  // `www-authenticate` 得**先写进响应**再抛:h3 的 `createError` 只接受状态码/文案/data,
  // 不接受响应头,而抛出去的错会走 error 处理链,那时再补头就晚了。
  setHeader(event, 'www-authenticate', 'Bearer realm="agent-api"')
  throw createError({
    statusCode: 401,
    message: unauthorizedApiMessage(state.reason),
    data: { reason: state.reason },
  })
}

/** h3 的 `getHeader` 会返回 string | undefined;数组形态(重复头)这里当没带。 */
function headerOrUndefined(event: H3Event, name: string): string | undefined {
  const value = getHeader(event, name)
  return typeof value === 'string' ? value : undefined
}
