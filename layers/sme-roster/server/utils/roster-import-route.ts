import { requestLogContext } from '../../../core/lib/logging'
import { useDb } from '@db'
import { createCoreRouteHandler } from '../../../core/server/utils/core-route'
import { handleRosterImportRequest, type RosterImportAction } from './roster-import-http'

/**
 * 名录导入三条写路由（`/preflight`、`/commit`、`/replay`）**共用的那层胶水**。
 *
 * 为什么要有它：三个路由文件的处理体逐字相同，只差一个 `action` 字面量 —— 各抄一份，
 * 抄漏一行（比如漏转发某个请求头）就是一个只在某一条端点上出现的缺陷。胶水只此一份
 * （RL-19 加 `/replay` 时收拢；判据本来就只有一份，在 `roster-import-http.ts`）。
 *
 * 本文件**会**用到 h3（`defineEventHandler` / `readBody` / `useRuntimeConfig` …，由 Nuxt
 * 自动导入），所以它只能被 route 文件 import —— 裸 node 的 vitest 进程解析不到 h3
 * （见 `layers/sme-roster/server/utils/roster-import-http.ts` 顶部的说明）。测试读路由文件是**按文本读**
 * （`tests/roster-import-api.test.ts` / `tests/agent-http.test.ts`），不 import 它。
 *
 * 路由文件里仍然**各自保留**自己的 `defineRouteMeta({ … })`：nitro 的 handlers-meta 插件
 * 只按 AST 抽**顶层**的 `defineRouteMeta(` 调用，把它挪进工厂就等于把那条路由从 spec 里删掉
 * （`tests/agent-http.test.ts` 钉着这条）。所以这里只收「event → 请求描述 → 响应回填」。
 */
export function createRosterImportHandler(action: RosterImportAction) {
  // 「读 method / 读两个头 / 读 body / 贴状态码与响应头」这段胶水本身由
  // `core-route.ts` 单点维护(RL-10 收拢)—— 这里只剩「哪个动作 + 要哪些依赖」。
  return defineEventHandler(event => createCoreRouteHandler(
    (request, ctx) => handleRosterImportRequest(action, request, ctx),
    () => ({ get db() { return useDb() }, apiToken: useRuntimeConfig().apiToken, filesDir: useRuntimeConfig().filesDir, logContext: requestLogContext(event) }),
  )(event))
}
