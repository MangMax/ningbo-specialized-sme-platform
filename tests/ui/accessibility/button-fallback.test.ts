import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 兜底环是纯 CSS 契约:组件渲染测不出真实层叠,这里直接锁定样式表源码。
const css = readFileSync('layers/core/app/assets/css/tailwind.css', 'utf8')

function layerBlock(name: string): string {
  const match = css.match(new RegExp(`@layer\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!match || match[1] === undefined) throw new Error(`缺少 @layer ${name} 块`)
  return match[1]
}

describe('原生按钮的全局 focus-visible 兜底环', () => {
  it('在 @layer base 中用 --ring 画 2px 焦点环并留出 offset', () => {
    const base = layerBlock('base')
    const rule = base.match(/button([^{]*):focus-visible\s*\{([^}]*)\}/)
    expect(rule, '@layer base 缺少 button:focus-visible 兜底规则').not.toBeNull()
    expect(rule![2]).toContain('outline: 2px solid var(--ring)')
    expect(rule![2]).toMatch(/outline-offset:\s*\d+px/)
  })

  it('排除已带焦点样式的 ui 组件(data-slot),不产生双环', () => {
    const base = layerBlock('base')
    const selector = base.match(/button([^{]*):focus-visible\s*\{/)?.[1] ?? ''
    expect(selector).toContain(':not([data-slot])')
  })

  it('兜底规则自身不引入动画或过渡', () => {
    const base = layerBlock('base')
    const rule = base.match(/button[^{]*:focus-visible\s*\{([^}]*)\}/)![1]
    expect(rule).not.toMatch(/animation|transition/)
  })
})
