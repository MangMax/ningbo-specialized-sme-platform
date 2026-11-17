import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 悬浮抽屉阴影的主题契约（票 #865）。
 *
 * 缝隙（seam）：样式表源码本身 —— `[data-floating-drawer]` 的公开契约是
 * 「三档宽度共用同一个阴影」。此前 `box-shadow: 0 8px 24px rgb(0 0 0 / 0.1)`
 * 是纯黑，暗色主题下影子仍然比底色深一档可读性差且与 statistics.css 的
 * `color-mix(in oklch, var(--foreground) …)` 写法不一致。
 *
 * 断言分两块：
 *  1. 阴影收敛到 `--drawer-shadow` 单一变量，且基座只声明/引用一次 ——
 *     防止以后某档宽度偷偷覆盖阴影回到分裂状态。
 *  2. 阴影颜色随 --foreground 走（color-mix），不再出现固定的纯黑/近黑
 *     rgb() 或 hex 字面量 —— 亮暗主题自动切换。
 */

const tailwindCss = readFileSync(
  fileURLToPath(new URL('../../../assets/css/tailwind.css', import.meta.url)),
  'utf8',
)

// 只取 [data-floating-drawer] 规则块（到文件尾，drawer 块是 tailwind.css 的末段），
// 避免文件其它位置的合法黑色字面量干扰断言。
const drawerSection = tailwindCss.slice(tailwindCss.indexOf('[data-floating-drawer]'))

describe('悬浮抽屉阴影（#865）', () => {
  it('三档宽度共用 --drawer-shadow：box-shadow 只引用该变量，宽度档不再各自声明', () => {
    const shadowDeclarations = drawerSection.match(/box-shadow\s*:[^;]+/g) ?? []
    expect(shadowDeclarations).toEqual(['box-shadow: var(--drawer-shadow)'])
    // 亮色基座只声明一次；宽度档只允许覆盖 --drawer-width。
    const baseBlock = drawerSection.slice(0, drawerSection.indexOf('}'))
    expect(baseBlock.match(/--drawer-shadow\s*:/g)).toHaveLength(1)
  })

  it('亮色阴影随 --foreground 混合（与 statistics.css 同源），不再是固定纯黑', () => {
    const baseBlock = drawerSection.slice(0, drawerSection.indexOf('}'))
    const shadowValue = baseBlock.match(/--drawer-shadow\s*:\s*([^;]+);/)?.[1] ?? ''
    expect(shadowValue).toContain('color-mix')
    expect(shadowValue).toContain('var(--foreground)')
    // 亮色基座里不允许出现固定深色字面量。
    expect(shadowValue).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}/)
  })

  it('暗色主题覆写同一变量为更深阴影，且颜色仍随主题混合（非固定字面量）', () => {
    // 浅色前景混合在暗底上读作光晕而非投影，故暗色把阴影从 --page 向黑色
    // 混合；关键是覆写同一个 --drawer-shadow（而非第二个 box-shadow 声明），
    // 且颜色仍由主题 token 经 color-mix 派生，不得退回固定 rgb()/hex 纯黑。
    const darkOverride = drawerSection.match(/\.dark \[data-floating-drawer\]\s*\{([^}]+)\}/)?.[1] ?? ''
    expect(darkOverride).toMatch(/--drawer-shadow\s*:/)
    expect(darkOverride).not.toMatch(/box-shadow\s*:/)
    expect(darkOverride).toContain('color-mix')
    expect(darkOverride).not.toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}/)
  })
})
