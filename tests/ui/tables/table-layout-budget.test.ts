import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * 列表页表格视口预算与最小宽度（票 #868）。
 *
 * 缝隙（seam）：`layers/core/app/assets/css/tailwind.css` 的 token 层 + 各列表页的 `.vue` 源码。
 * 这条契约约束两件事：
 *  1. `.data-table-scroll` 的纵向滚动预算不再写死 `calc(100dvh - 17rem)`，
 *     而是引用 token 层的 `--table-budget` —— 新页面不必照抄那三个页面的预算。
 *  2. 各列表页的 `min-w` 不是逐页拍的字面量,而是按列内容推导出的规范值
 *     （见 DESIGN.md §2.1 的推导规则）;每个调用点引用的值与其列构成自洽。
 */

const root = path.resolve(__dirname, '../../..')
const cssPath = path.join(root, 'layers/core/app/assets/css/tailwind.css')
const cssDir = path.dirname(cssPath)
const css = readFileSync(cssPath, 'utf8')

async function compileTailwind(candidates: string[]) {
  const require = createRequire(import.meta.url)
  const vitePlugin = require.resolve('@tailwindcss/vite')
  const nodeModule = createRequire(vitePlugin).resolve('@tailwindcss/node')
  const { compile } = await import(nodeModule)
  const compiler = await compile(readFileSync(cssPath, 'utf8'), {
    base: cssDir,
    onDependency() {},
  })
  return compiler.build(candidates)
}

function readPage(rel: string) {
  return readFileSync(path.join(root, rel), 'utf8')
}

describe('表格滚动预算 token', () => {
  it('--table-budget 在 @theme 里定义并落到 :root', () => {
    // 非 inline 的 @theme 会把 --table-budget 实体输出到 :root,普通规则才能 var()。
    const themeBlock = css.match(/@theme\s*\{(?!inline)([^}]*)\}/)
    expect(themeBlock).not.toBeNull()
    expect(themeBlock![0]).toMatch(/--table-budget\s*:\s*[^;]+;/)
  })

  it('.data-table-scroll 引用 var(--table-budget)，不再写死 17rem', () => {
    const scrollRule = css.match(/\.data-table-scroll\s*\{[^}]*\}/)
    expect(scrollRule).not.toBeNull()
    expect(scrollRule![0]).toContain('var(--table-budget)')
    expect(scrollRule![0]).not.toContain('17rem')
    // 仍保留 100dvh 视口差与 320px 下限。
    expect(scrollRule![0]).toContain('100dvh')
    expect(scrollRule![0]).toMatch(/max\(\s*320px/)
  })

  it('编译后 --table-budget 落到 :root，.data-table-scroll 消费 var()', async () => {
    const out = await compileTailwind(['data-table-scroll'])
    // 非 inline @theme 把 token 实体输出到 :root,普通规则才能 var() 引用。
    expect(out).toMatch(/--table-budget:\s*17rem/)
    expect(out).toMatch(/\.data-table-scroll\s*\{[^}]*var\(--table-budget\)/)
  })
})

describe('列表页 min-w 收敛为推导值', () => {
  // 百分比列的页面:min-w 是各列内容下限之和的落地值,规范登记为固定档位。
  it('logs.vue / current-enterprises.vue 的 min-w 落在规范推导档位上', () => {
    const logs = readPage('layers/core/app/pages/logs.vue')
    const current = readPage('pages/current-enterprises.vue')
    expect(logs).toContain('min-w-[940px]')
    expect(current).toContain('min-w-[850px]')
  })

  it('index（EnterpriseListTable）的最小宽度挂在响应式断点上，窄屏 min-w-0', () => {
    const table = readPage('layers/sme-roster/app/components/EnterpriseListTable.vue')
    // 窄屏按内容铺开(min-w-0),lg 起才有列宽下限 980px。
    expect(table).toContain('min-w-0')
    expect(table).toMatch(/lg:min-w-\[980px\]/)
  })
})
