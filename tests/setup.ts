/**
 * vitest 的**测试环境垫片**(票 19 补)。
 *
 * 路由文件里用的 `defineRouteMeta` 是 **Nitro 的编译期宏**:构建时由 nitro 的
 * `handlers-meta` 插件按 AST 静态求值抽进 spec,运行时它**根本不存在**。
 * 但本仓的 vitest 跑在**裸 node** 下(没有 Nuxt 的虚拟模块与自动导入),
 * 而 `tests/curation.test.ts` / `tests/comparison-export.test.ts` 这类用例
 * 会**直接 import 路由文件** —— 于是 `defineRouteMeta(...)` 在模块求值时就炸
 * (`ReferenceError: defineRouteMeta is not defined`),把原本能过的用例弄挂。
 *
 * 这里给它一个**空实现**:与 nitro 的语义一致(宏的返回值没人用,它的作用是副作用 ——
 * 让插件能静态看见那段字面量),所以返回入参即可。**只在测试进程里生效,
 * 不改任何运行时行为**:真实构建走的仍是 nitro 注入的宏。
 *
 * 加新宏时往下面加一行,并在注释里写清它对应 nitro 的哪个编译期钩子。
 */

import { initLogger } from 'evlog'
import { beforeAll } from 'vitest'
import { installApplicationUi } from '../lib/install-application-ui'

// Direct runtime fixtures use the same registrations as the two app entries.
installApplicationUi()
beforeAll(async () => {
  // Load after suite-level mocks have been registered.
  const { installApplicationServer } = await import('../server/install-application')
  installApplicationServer()
})

// Bare unit tests do not boot evlog/nuxt. Keep event construction enabled, but
// give diagnostics an explicit quiet unit sink instead of flooding Vitest's
// console RPC with every Drizzle query. Logging tests install their own real
// drain via initializeWorkerLogging/initLogger; child Nuxt apps boot normally.
// This does not silence console errors or ignore unhandled test errors.
initLogger({ enabled: true, silent: true, pretty: false, drain: () => {} })

// `server/**` 路由里的编译期宏。生产构建由 nitro 的 unimport 注入,
// 测试进程没有 —— 这里补上,免得「加了宏」=「挂掉别人的用例」。
//
// 类型上 nitro 已经把它声明成全局的 `const`(所以这里不能再 `declare global`),
// 但那个声明只是**编译期**的:运行时它要靠 unimport 注入,裸 node 下并不存在。
// 于是这里用一次属性赋值把它补上 —— 运行时行为只在测试进程里被改动。
;(globalThis as unknown as Record<string, unknown>).defineRouteMeta = (meta: unknown) => meta

// Nuxt's **auto-import** for `<head>`: 页面源码里是**不带前缀**的 `useHead(...)`,
// 由 unimport 在构建期注入。裸 node 下它同样不存在 —— 页面级用例
// (`tests/task-center-ui.test.ts`) 会直接挂载 `pages/*.vue`,于是补一个空实现。
// 与 defineRouteMeta 同理:只改测试进程,真实构建仍走 Nuxt 注入。

// Router composables are auto-imported unprefixed too. Under vitest there is no
// Nuxt app context, so `vue-router`'s own `useRoute()` cannot see the router a
// test mounts. Page tests publish the router they mounted on `__routerBridge`;
// without one, these fall back to the library implementation.
;(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.useHead ??= () => {}
  const bridge: { current: unknown } = { current: null }
  g.__routerBridge = bridge
  type RouterLike = ReturnType<typeof import('vue-router')['useRouter']>
  void import('vue-router').then((lib) => {
    g.useRoute = () => (bridge.current as RouterLike | null)?.currentRoute?.value ?? lib.useRoute()
    g.useRouter = () => (bridge.current as RouterLike | null) ?? lib.useRouter()
  })
})()
