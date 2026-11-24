// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { designTokenCategories } from '../../../layers/core/lib/design-tokens'

/**
 * Design Token 目录与样式表的契约。
 *
 * 缝隙：`layers/core/lib/design-tokens.ts` 是目录/预览页/文档共用的元数据，
 * 但它只是 `layers/core/app/assets/css/tailwind.css` 的镜像。这条测试把
 * 「镜像说的名字确实存在」钉死，避免预览页渲染出一块空色板、文档写出一个
 * 已经不存在的变量：
 *  1. 双色板 token 在 `:root` 与 `.dark` 里成对定义；
 *  2. `@theme` / `@theme inline` 的刻度在主题层声明，并能落到编译产物；
 *  3. Tabs 面板的 JS 缓动与 `--ease-snap` 一致；
 *  4. 开发态预览页能挂载并渲染全部 12 类分组。
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
  const compiler = await compile(readFileSync(cssPath, 'utf8'), { base: cssDir, onDependency() {} })
  return compiler.build(candidates)
}

/** 取 `:root { … }` 与 `.dark { … }` 的声明块（不含 `@theme` 里的同名刻度）。 */
function paletteBlock(selector: ':root' | '.dark'): string {
  const start = css.search(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{`))
  expect(start, `样式表里应有 ${selector} 块`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open, i + 1)
    }
  }
  throw new Error(`${selector} 块未闭合`)
}

function declares(block: string, name: string) {
  return new RegExp(`${name}\\s*:`).test(block)
}

const paletteTokens = designTokenCategories
  .flatMap((category) => category.tokens)
  .filter((token) => token.scope === 'palette')
const themeTokens = designTokenCategories
  .flatMap((category) => category.tokens)
  .filter((token) => token.scope === 'theme')
const rootTokens = designTokenCategories
  .flatMap((category) => category.tokens)
  .filter((token) => token.scope === 'root')

describe('Design Token 目录覆盖 12 类', () => {
  it('目录登记 12 个分组，每个分组都有标题、说明和 token', () => {
    expect(designTokenCategories).toHaveLength(12)
    expect(designTokenCategories.map((category) => category.id)).toEqual([
      'surface', 'text', 'border', 'fill', 'shadow-z', 'primary',
      'status', 'domain', 'radius', 'typography', 'motion', 'layout',
    ])
    for (const category of designTokenCategories) {
      expect(category.title.trim(), `${category.id} 缺标题`).not.toBe('')
      expect(category.summary.trim(), `${category.id} 缺说明`).not.toBe('')
      expect(category.tokens.length, `${category.id} 没有 token`).toBeGreaterThan(0)
      for (const token of category.tokens) {
        expect(token.name, `${category.id} 的 token 名`).toMatch(/^--[a-z0-9-]+$/)
        expect(token.cssVar).toBe(`var(${token.name})`)
        expect(token.role.trim(), `${token.name} 缺 role`).not.toBe('')
        expect(token.usage.trim(), `${token.name} 缺 usage`).not.toBe('')
      }
    }
  })

  it('token 名全目录唯一，避免同一变量被两处分头维护', () => {
    const names = designTokenCategories.flatMap((category) => category.tokens.map((token) => token.name))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('双色板 token 在 :root 与 .dark 成对定义', () => {
  const light = paletteBlock(':root')
  const dark = paletteBlock('.dark')

  it('每个 palette token 都出现在 :root 和 .dark', () => {
    expect(paletteTokens.length).toBeGreaterThan(20)
    for (const token of paletteTokens) {
      expect(declares(light, token.name), `:root 缺 ${token.name}`).toBe(true)
      expect(declares(dark, token.name), `.dark 缺 ${token.name}`).toBe(true)
    }
  })

  it('明暗两套色板的登记取值与样式表一致', () => {
    for (const token of paletteTokens) {
      if (token.scope !== 'palette') continue
      expect(light, `:root 的 ${token.name} 与目录不符`).toContain(token.lightValue)
      expect(dark, `.dark 的 ${token.name} 与目录不符`).toContain(token.darkValue)
    }
  })

  it('阴影 token 走 color-mix 派生，不用固定的纯黑字面量', () => {
    for (const token of paletteTokens.filter((item) => item.name.startsWith('--shadow-'))) {
      if (token.scope !== 'palette') continue
      const values = [token.lightValue, token.darkValue].filter((value) => value !== 'none')
      for (const value of values) {
        expect(value, `${token.name} 的阴影应经 color-mix 派生`).toContain('color-mix')
        expect(value, `${token.name} 不应写死颜色字面量`).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}/)
      }
    }
  })
})

describe('@theme 刻度声明并落到编译产物', () => {
  it('每个 theme/root token 都写进 @theme（含 static）或 @theme inline', () => {
    const themeBlocks = [...css.matchAll(/@theme(?:\s+static)?(?:\s+inline)?\s*\{([\s\S]*?)\n\}/g)]
    const declared = themeBlocks.map((match) => match[1]!).join('\n')
    expect(themeBlocks.length).toBeGreaterThan(0)
    for (const token of themeTokens) {
      expect(declares(declared, token.name), `@theme 缺 ${token.name}`).toBe(true)
    }
    // `:root` 单值(圆角基准、OCR 字号)只需要在样式表里定义一次。
    for (const token of rootTokens) {
      expect(declares(css, token.name), `样式表缺 ${token.name}`).toBe(true)
    }
  })

  it('scale 类 token 编译后仍能从 :root 读到', async () => {
    const out = await compileTailwind(['data-table'])
    for (const token of themeTokens.filter((item) => !item.name.startsWith('--text-'))) {
      if (token.scope !== 'theme') continue
      expect(out, `编译产物缺 ${token.name}`).toMatch(
        new RegExp(`${token.name.replace(/-/g, '\\-')}\\s*:\\s*${token.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      )
    }
  })

  it('层级 token 被固定操作列消费，而不是写死数字', () => {
    expect(css).toMatch(/\.table-sticky-action-head\s*\{[^}]*z-index:\s*var\(--z-sticky-head\)/)
    expect(css).toMatch(/\.table-sticky-action-cell\s*\{[^}]*z-index:\s*var\(--z-sticky-cell\)/)
  })

  it('抽屉三档宽度引用 token，阴影经 --drawer-shadow 引用 --shadow-drawer', () => {
    expect(css).toMatch(/\[data-floating-drawer\]\s*\{[^}]*--drawer-width:\s*var\(--drawer-width-standard\)/)
    expect(css).toMatch(/\[data-floating-drawer='compact'\]\s*\{\s*--drawer-width:\s*var\(--drawer-width-compact\)/)
    expect(css).toMatch(/\[data-floating-drawer='detail'\]\s*\{\s*--drawer-width:\s*var\(--drawer-width-detail\)/)
    expect(css).toMatch(/--drawer-shadow:\s*var\(--shadow-drawer/)
    const drawerSection = css.slice(css.indexOf('[data-floating-drawer]'))
    expect(drawerSection.match(/box-shadow\s*:[^;]+/g)).toEqual(['box-shadow: var(--drawer-shadow)'])
  })
})

describe('动效缓动一致', () => {
  it('TabsContent 用 [0.215, 0.61, 0.355, 1] 与 --motion-ease-out / --ease-snap 对齐', () => {
    const source = readFileSync(
      path.join(root, 'layers/core/app/components/ui/tabs/TabsContent.vue'),
      'utf8',
    )
    expect(source).toContain('[0.215, 0.61, 0.355, 1]')
    expect(source).not.toContain("ease: 'easeOut'")
    expect(source).toContain('--ease-snap')
  })

  it('--ease-snap 与 --motion-ease-out 保持同一条贝塞尔', () => {
    expect(css).toMatch(/--ease-snap:\s*cubic-bezier\(0\.215,\s*0\.61,\s*0\.355,\s*1\)/)
    expect(css).toMatch(/--motion-ease-out:\s*cubic-bezier\(0\.215,\s*0\.61,\s*0\.355,\s*1\)/)
  })
})

describe('开发态预览页', () => {
  it('挂载后渲染全部 12 类分组标题', async () => {
    const Page = (await import('../../../layers/core/app/pages/design-tokens.vue')).default
    expect(Page).toBeTruthy()
    const view = mount(Page, {
      global: { stubs: { Teleport: true } },
    })
    try {
      await flushPromises()
      const headings = view.findAll('[data-token-category] h2').map((node) => node.text())
      expect(headings).toEqual(designTokenCategories.map((category) => category.title))
      const anchors = view.findAll('nav[aria-label="Design Tokens 目录"] a')
      expect(anchors).toHaveLength(designTokenCategories.length)
      expect(anchors.map((anchor) => anchor.attributes('href'))).toEqual(
        designTokenCategories.map((category) => `#token-${category.id}`),
      )
    } finally {
      view.unmount()
    }
  })
})
