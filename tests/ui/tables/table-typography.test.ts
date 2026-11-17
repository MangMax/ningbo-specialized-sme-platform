import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const cssDir = path.resolve(__dirname, '../../../assets/css')
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

describe('表格字号 token', () => {
  it('tailwind.css 通过 @theme 暴露 text-table 工具类，字号 13px 行高 20px', async () => {
    const css = await compileTailwind(['text-table'])
    expect(css).toContain('--text-table: 0.8125rem')
    expect(css).toContain('--text-table--line-height: 1.25rem')
    expect(css).toMatch(/\.text-table\s*\{[^}]*font-size:\s*var\(--text-table\)/)
    expect(css).toMatch(/\.text-table\s*\{[^}]*line-height:/)
  })

  it('.data-table 引用 text-table token 而不是写死像素', () => {
    const source = readFileSync(cssPath, 'utf8')
    const tableRule = source.match(/\.data-table\s*\{[^}]*font-size[^}]*\}/)
    expect(tableRule).not.toBeNull()
    expect(tableRule![0]).toContain('var(--text-table)')
    expect(tableRule![0]).not.toContain('13px')
    expect(tableRule![0]).not.toContain('20px')
  })

  it('data-table 候选类经主题编译后仍得到同一字号声明', async () => {
    const css = await compileTailwind(['data-table'])
    expect(css).toMatch(/\.data-table\s*\{[^}]*font-size:\s*var\(--text-table\)/)
  })
})
