/**
 * 「**h3-free 核心** + 薄路由」的共用胶水(RL-10 收拢,RL-19 的 `roster-import-route.ts` 也走它)。
 *
 * ── 这套分法是为什么 ────────────────────────────────────────────────────
 *
 * 本仓的写入口都是两层:**判据在核心**(不 import h3,只吃一个最小的请求描述,
 * 于是同一份实现既能被 Nitro 路由调用,也能被真实端口的 HTTP 回放测试直接驱动 ——
 * 测的不是替身实现),**路由只是胶水**(把 h3 的 event 翻成那个请求描述,再把响应贴回去)。
 * 详见 `roster-import-http.ts` 顶部与 `tests/helpers/http-fixture.ts`。
 *
 * 胶水本身**逐字重复**过:每加一个写入口就抄一遍「读 method / 读两个头 / 读 body /
 * 贴状态码与响应头」。抄漏一行(比如漏转发某个头)就是一个只在某一条端点上出现的缺陷 ——
 * 与 RL-19 当初把三条导入路由收拢成一份工厂同一条理由。这里把它收成**一处**。
 *
 * ⚠️ 本文件**会**用到 h3(`defineEventHandler` / `getMethod` / `readBody` / `getHeader` /
 * `setResponseStatus` / `setHeader`,由 Nuxt 自动导入),所以它只能被 **route 文件** import ——
 * 裸 node 的 vitest 进程解析不到 h3(见 `roster-import-http.ts` 顶部那段)。
 * 测试也别 import 它;要测行为就打真实端口(`tests/helpers/*-http-server.ts`)。
 *
 * ⚠️ **路由文件仍各自保留自己的 `defineRouteMeta({ … })`**:nitro 的 handlers-meta 插件
 * 只按 AST 抽**顶层**的 `defineRouteMeta(` 调用(`tests/agent-http.test.ts` 钉着这条),
 * 把它挪进工厂就等于把那条路由从 OpenAPI spec 里删掉。
 */

import { defineEventHandler, getMethod, getHeader, readBody, setHeader, setResponseStatus, getResponseStatus, type H3Event } from 'h3'
import { requestLogContext } from '../../layers/core/lib/logging'
import { logSemanticOperation } from '../../layers/core/server/utils/semantic-operation-log'

/** Shared semantic boundary. Callers supply only a static operation name, never a URL or input. */
export function semanticRouteHandler<T>(operation: string, handler: (event: H3Event) => T | Promise<T>) {
  return defineEventHandler(async event => {
    const started = performance.now()
    try {
      const result = await handler(event)
      logSemanticOperation('http', operation, requestLogContext(event), started, result, getResponseStatus(event))
      return result
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
      logSemanticOperation('http', operation, requestLogContext(event), started, error, status, true)
      throw error
    }
  })
}

/** 核心函数吃的**最小请求描述**(不含任何 h3 类型)。 */
export interface CoreRequest {
  /** 大写 HTTP 方法;方法守卫由**核心自己**做(路由不替它拦)。 */
  method: string
  headers: Record<string, string | undefined>
  /** 已解析的请求体(JSON);解析失败给 `null`。 */
  body: unknown
}

/** 核心函数返回的状态码 + 响应头 + JSON 体。 */
export interface CoreResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/**
 * 把一个核心函数挂成 Nitro 事件处理器。
 *
 * `buildCtx` 由**调用方的工厂**给(每条写入口自己知道要 `useDb()` 还是别的依赖);
 * 运行时配置也由它读 —— 让每条路由各自再读一遍就是几份会各自漂的实现。
 */
export function createCoreRouteHandler<Ctx>(
  core: (request: CoreRequest, ctx: Ctx) => CoreResponse | Promise<CoreResponse>,
  buildCtx: () => Ctx,
) {
  const handler = async (event: H3Event) => {
    const response = await core(
      {
        method: getMethod(event),
        headers: {
          authorization: headerString(event, 'authorization'),
          'x-api-token': headerString(event, 'x-api-token'),
        },
        // body 解析失败给 `null`,由核心报 400 —— 路由不替它决定「读不出来算什么」。
        body: await readBody(event).catch(() => null),
      },
      buildCtx(),
    )
    setResponseStatus(event, response.status)
    for (const [name, value] of Object.entries(response.headers)) setHeader(event, name, value)
    return response.body
  }
  return defineEventHandler(handler)
}

/** h3 的 `getHeader` 返回 `string | undefined`;重复头(数组)当没带。 */
function headerString(event: Parameters<typeof getHeader>[0], name: string): string | undefined {
  const value = getHeader(event, name)
  return typeof value === 'string' ? value : undefined
}
