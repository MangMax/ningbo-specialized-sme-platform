import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * 表格尺寸的事实标准（DESIGN.md §2 表格 / §2.2 工具栏尺寸）。
 *
 * 缝隙：`layers/core/app/assets/css/tailwind.css` 的 components 层 + 基础组件默认值。
 * 这里锁三件事：
 *  1. 默认行最小高 44px、表头 36px、左右 12px；紧凑档 36px 只在 data-density 下生效；
 *  2. 这些规则位于 `@layer components` —— utilities 层在后，调用点的 `p-0` / `py-*`
 *     才能覆盖它们（空态、骨架屏、弹窗小表都依赖这一点）；
 *  3. 基础组件（TableHead / Input）的默认值与上述标准一致。
 */

const cssDir = path.resolve(__dirname, '../../../layers/core/app/assets/css')
const cssPath = path.join(cssDir, 'tailwind.css')

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

/** 按花括号配对取出某个 `@layer name { … }` 的完整内容（编译产物里层块会嵌套）。 */
function layerBlock(css: string, name: string): string {
  const start = css.indexOf(`@layer ${name} {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, i + 1)
    }
  }
  return ''
}

describe('表格尺寸与分层', () => {
  it('默认行最小高 44px、紧凑档 36px，都写在 @layer components 内', async () => {
    const out = await compileTailwind(['data-table', 'p-0', 'py-1.5'])
    // 层顺序声明里 components 必须在 utilities 之前，utilities 才能覆盖默认内边距。
    expect(out).toMatch(/@layer theme, base, components, utilities;/)
    const components = layerBlock(out, 'components')
    expect(components).toContain('.data-table > tbody > tr {')
    expect(components).toMatch(/\.data-table\s*>\s*tbody\s*>\s*tr\s*\{[^}]*height:\s*44px/)
    expect(components).toMatch(/\.data-table\[data-density='compact'\]\s*>\s*tbody\s*>\s*tr\s*\{[^}]*height:\s*36px/)
    expect(components).toMatch(/\.data-table\[data-density='compact'\][^{]*td[^{]*\{[^}]*padding-block:\s*6px/)
  })

  it('表头 36px、单元格左右 12px，且 p-0 工具类仍可覆盖', async () => {
    const out = await compileTailwind(['data-table', 'p-0'])
    const components = layerBlock(out, 'components')
    expect(components).toMatch(/\.data-table\s*>\s*thead\s*>\s*tr\s*>\s*th\s*\{[^}]*height:\s*36px[^}]*padding-inline:\s*12px/)
    expect(components).toMatch(/\.data-table\s*>\s*tbody\s*>\s*tr\s*>\s*td[^{]*\{[^}]*padding-block:\s*10px[^}]*padding-inline:\s*12px/)
    // p-0 在 utilities 层，声明顺序在 components 之后 —— 覆盖成立。
    expect(out).toMatch(/@layer theme, base, components, utilities;/)
    expect(out).toMatch(/\.p-0\s*\{\s*padding:\s*0px;/)
  })

  it('固定右侧操作列与行悬停联动，减少动效时关掉过渡', async () => {
    const out = await compileTailwind(['table-sticky-action-head', 'table-sticky-action-cell'])
    const components = layerBlock(out, 'components')
    expect(components).toMatch(/\.table-sticky-action-head\s*\{[^}]*position:\s*sticky[^}]*right:\s*0/)
    expect(components).toMatch(/\.table-sticky-action-cell\s*\{[^}]*background:\s*var\(--card\)/)
    expect(components).toMatch(/tr:hover\s*>\s*\.table-sticky-action-cell\s*\{[^}]*color-mix/)
    expect(out).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.table-sticky-action-cell\s*\{[^}]*transition:\s*none/,
    )
  })

  it('列表工作区的高度链逐级 flex:1 / min-height:0', async () => {
    const out = await compileTailwind(['workspace-list', 'paginated-table-body'])
    const components = layerBlock(out, 'components')
    expect(components).toMatch(
      /\.workspace-list,\s*\.workspace-list-body,\s*\.paginated-table-card,\s*\.paginated-table-body\s*\{[^}]*flex:\s*1 1 0%[^}]*min-height:\s*0/,
    )
    expect(components).toMatch(
      /\.workspace-list\s+:where\(\.data-table-scroll\)\s*\{[^}]*flex:\s*1 1 0%[^}]*max-height:\s*none/,
    )
  })
})

describe('基础组件默认值', () => {
  it('Table 的默认字号是 text-table，不用 text-sm 反压 components 层', () => {
    // utilities 层在 components 之后；若 Table.vue 默认带 text-sm，
    // 就会把 `.data-table` 的 13px 覆盖回 14px。
    const table = readFileSync(
      path.resolve(__dirname, '../../../layers/core/app/components/ui/table/Table.vue'),
      'utf8',
    )
    expect(table).toContain('text-table')
    expect(table).not.toContain('text-sm')
  })

  it('TableHead 默认左右内边距 px-3，与 TableCell 对齐', () => {
    const head = readFileSync(
      path.resolve(__dirname, '../../../layers/core/app/components/ui/table/TableHead.vue'),
      'utf8',
    )
    const cell = readFileSync(
      path.resolve(__dirname, '../../../layers/core/app/components/ui/table/TableCell.vue'),
      'utf8',
    )
    expect(head).toContain('px-3')
    expect(head).not.toContain('px-2 ')
    expect(head).toContain('h-9')
    expect(cell).toContain('px-3')
    expect(cell).toContain('py-2.5')
  })
})
