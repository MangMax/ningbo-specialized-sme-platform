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

// `server/**` 路由里的编译期宏。生产构建由 nitro 的 unimport 注入,
// 测试进程没有 —— 这里补上,免得「加了宏」=「挂掉别人的用例」。
//
// 类型上 nitro 已经把它声明成全局的 `const`(所以这里不能再 `declare global`),
// 但那个声明只是**编译期**的:运行时它要靠 unimport 注入,裸 node 下并不存在。
// 于是这里用一次属性赋值把它补上 —— 运行时行为只在测试进程里被改动。
;(globalThis as unknown as Record<string, unknown>).defineRouteMeta = (meta: unknown) => meta
