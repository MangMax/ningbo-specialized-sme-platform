/**
 * Node 的**扩展名解析钩子** —— 让 `scripts/*.mjs` 能直接 import 本仓的 `.ts` 模块。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `scripts/reconcile-live.mjs` 必须跑**同一份**核心逻辑(不能把逻辑抄进脚本)。
 * 核心是 TypeScript(`server/utils/platform-reconcile.ts` + `lib/platform/*`),而
 * 本仓的 import 一律**省略扩展名**(`from './adapter'`)。Node 自带的类型剥离
 * (Node ≥ 22.18 / 23.6 默认开启)能跑 `.ts`,但**不做扩展名补全** ——
 * 于是 `import './adapter'` 直接 `ERR_MODULE_NOT_FOUND`。
 *
 * 这个钩子只补一件事:相对/绝对说明符找不到时,依次试 `.ts` / `/index.ts` /
 * `.mjs` / `.js` / `/index.mjs`。**不加别名**(`@db` / `~` 是 Nuxt 的,Vitest 与
 * Nuxt 自己解析)—— 本脚本只 import 那几块不依赖别名的模块。
 *
 * 不引入新依赖、不改 `package.json`:`module.register` 是 Node 自带的能力(`node:module`)。
 * 注意 Node 的两种类型剥离模式 —— 本仓有构造器参数属性,所以入口脚本会带上
 * `--experimental-transform-types`(真编译)重跑一次自己;见 `scripts/reconcile-live.mjs`。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CANDIDATE_EXTENSIONS = ['.ts', '/index.ts', '.mjs', '.js', '/index.mjs']

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  if ((isRelative || specifier.startsWith('/')) && context.parentURL) {
    const hasExtension = /\.[cm]?[jt]s$/.test(specifier)
    if (!hasExtension) {
      for (const extension of CANDIDATE_EXTENSIONS) {
        const candidate = new URL(specifier + extension, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(specifier + extension, context)
        }
      }
    }
  }
  return nextResolve(specifier, context)
}
