
import { describe, expect, it } from 'vitest'
import { badgeVariants } from '../../../layers/core/app/components/ui/badge'
import { cn } from '../../../layers/core/lib/utils'
import {
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_VARIANTS,
} from '../../../layers/sme-roster/lib/labels'


const STATES = Object.keys(DIFFERENCE_STATUSES)

describe('差异六态的单一出处', () => {

  it('每个取值都解析得出 class(写错变体名时 cva 不报错,只静默落回默认色)', () => {
        const fallback = badgeVariants({ variant: 'definitely-not-a-variant' as never })
    for (const code of STATES) {
      const variant = DIFFERENCE_STATUS_VARIANTS[code]!
      const cls = badgeVariants({ variant: variant as never })
      expect(cls, `${code} → ${variant}:解析不出 class`).toBeTruthy()
      expect(cls, `${code} → ${variant}:这是个 cva 不认识的变体名`).not.toBe(fallback)
    }
  })
})

describe('六态两两可区分', () => {
    const render = (code: string) =>
    cn(badgeVariants({ variant: DIFFERENCE_STATUS_VARIANTS[code] as never }))
  const rendered = Object.fromEntries(STATES.map((code) => [code, render(code)]))

  it('没有两个状态解析出同一串 class', () => {
    const seen = new Map<string, string>()
    for (const [code, cls] of Object.entries(rendered)) {
      const other = seen.get(cls)
      expect(other, `${code} 与 ${other} 渲染成同一枚徽章`).toBeUndefined()
      seen.set(cls, code)
    }
    expect(seen.size).toBe(STATES.length)
  })





  it('配对通道真的落到了 class 上(不是只在注释里说说)', () => {
    const has = (code: string, needle: string) => rendered[code]!.includes(needle)

    // 线型通道:未查询是虚线,无记录是实线。
    expect(has('not_queried', 'border-dashed')).toBe(true)
    expect(has('no_record', 'border-dashed')).toBe(false)

    // 字色通道:无记录深字,待核实灰字 —— 这一对**只差**这一处。
    expect(has('no_record', 'text-foreground')).toBe(true)
    expect(has('needs_review', 'text-muted-foreground')).toBe(true)

    // 底色通道:红 / 浅灰 / 主色三个实底各不相同;另三个没有底色。
    expect(has('query_failed', 'bg-destructive')).toBe(true)
    expect(has('confirmed_no_diff', 'bg-secondary')).toBe(true)
    expect(has('confirmed_reason', 'bg-primary')).toBe(true)
    for (const code of ['not_queried', 'no_record', 'needs_review']) {
      expect(rendered[code], `${code} 不该有底色`).toMatch(/bg-transparent|\btext-foreground\b/)
      expect(rendered[code], `${code} 不该有实底色`).not.toMatch(/bg-(primary|secondary|destructive)\b/)
    }

    // 逐对复核:六态两两至少差在一处可见通道上。三个通道取**实际 token**,
    // 而不是笼统的「有底色/没底色」—— 否则 `confirmed_no_diff`(浅灰底)与
    // `confirmed_reason`(主色底)会被判成同一档,而它们明明是两个颜色。
    const fill = (cls: string) => cls.match(/bg-(primary|secondary|destructive|tier-\d)\b/)?.[1] ?? 'none'
    const textTone = (cls: string) => (/text-muted-foreground/.test(cls) ? 'muted' : 'strong')
    const border = (cls: string) => (/border-dashed/.test(cls) ? 'dashed' : 'solid')
    const signature = (cls: string) => `${fill(cls)} · ${textTone(cls)} · ${border(cls)}`
    const signatures = Object.fromEntries(STATES.map((code) => [code, signature(rendered[code]!)]))
    expect(new Set(Object.values(signatures)).size).toBe(STATES.length)
    for (const a of STATES) {
      for (const b of STATES) {
        if (a >= b) continue
        expect(signatures[a], `${a} 与 ${b} 的可见通道完全一样`).not.toBe(signatures[b])
      }
    }
  })
})
