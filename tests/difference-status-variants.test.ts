import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { badgeVariants } from '../components/ui/badge'
import { cn } from '../lib/utils'
import {
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_VARIANTS,
  DIFFERENCE_STATUS_ORDER,
} from '../lib/labels'

/**
 * 差异六态徽章色 —— **单一出处 + 两两可区分**(契约 §3.2)。
 *
 * 为什么值得专门钉一条:仓里曾经同时存在**三份**「状态 → 徽章色」级联,取值互不相同。
 * 其中两份把 `not_queried`(未查询)与 `no_record`(无记录)画成同一枚 outline、
 * 把 `needs_review`(待核实)与 `query_failed`(查询失败)一律画红 —— 用户反馈过的
 * 「失败 ≠ 无记录、未查询 ≠ 无记录」当场失守,而且**页面上看不出来**:每一枚单独看都
 * 挺合理,只有把六态摆在一起才露馅。所以这里不做「代码里有没有 if」的检查,而是
 * **把六态真的渲染出来的 class 拿来比**:两两不同才算过。
 *
 * 用的是 `Badge` 组件自己的 `badgeVariants`(cva),不是另抄一份变体表 ——
 * 这样一旦有人给变体改名或改样式,这里会跟着变,不会两处各说各话。
 */

const STATES = Object.keys(DIFFERENCE_STATUSES)

describe('差异六态的单一出处', () => {
  it('六个状态一个不漏,都在 `DIFFERENCE_STATUS_VARIANTS` 里有取值', () => {
    expect(STATES.sort()).toEqual(Object.keys(DIFFERENCE_STATUS_VARIANTS).sort())
    for (const code of STATES) {
      expect(DIFFERENCE_STATUS_VARIANTS[code], `${code} 缺徽章变体`).toBeTruthy()
    }
  })

  it('展示顺序里的六个状态与字典一致(不多不少)', () => {
    expect([...DIFFERENCE_STATUS_ORDER].sort()).toEqual([...STATES].sort())
  })

  it('每个取值都解析得出 class(写错变体名时 cva 不报错,只静默落回默认色)', () => {
    /**
     * cva 对不认识的变体**不抛错**,只是那一段类名不出现 —— 于是页面照常渲染、
     * 只是退回默认色,谁也不会发现。所以这里正着查:每个取值解析出的 class
     * 必须和「`outline` 这个已知变体对未知取值的兜底」不同,也必须彼此不同
     * (后半条由下面「六态两两可区分」再钉一遍)。
     */
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
  /**
   * 六态各自**真实渲染出来**的 class 串。
   * 走 `cn(badgeVariants(...))` —— 与 `Badge.vue` 里那行一模一样 —— 而不是只比变体名:
   * `cn` 是 `twMerge`,会把同族工具类去重("后写的赢")。只比变体名会漏掉
   * 「调用点又挂了 `class="font-normal"`,把 `solid` 唯一的字重通道吃掉」这种改法。
   */
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

  it('六个变体名本身也两两不同(不靠变体以外的 class 凑区别)', () => {
    const variants = Object.values(DIFFERENCE_STATUS_VARIANTS)
    expect(new Set(variants).size).toBe(variants.length)
  })

  /**
   * 调用点不许给状态徽章挂 `font-*` / `text-*` 的 class。
   *
   * 这条来自一次真实回归:`quiet`(待核实)与 `outline`(无记录)之间**只有字色**这一处
   * 差别(灰字 vs 深字)。调用点随手挂一个 `class="text-…"` 就会被 `twMerge` 判为同族、
   * 后写的赢,把唯一的差别抹平 —— 而上面那条「比 class 串」的用例**照样通过**
   * (它比的是没挂 class 的版本)。所以这里直接看源码,把「调用点别压字重/字色」钉住。
   */
  it('调用点不给状态徽章压字重或字色(否则六态会静默糊回去)', () => {
    for (const file of [
      'components/RosterDifferenceTable.vue',
      'components/RosterEnterprisePanel.vue',
    ]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      const line = src.split('\n').find((l) => l.includes(':variant="statusVariant('))
      expect(line, `${file} 里找不到状态徽章那行`).toBeTruthy()
      expect(line, `${file}:状态徽章不该再挂 font-* / text-* 的 class`).not.toMatch(
        /class="[^"]*(?:font-|text-)/,
      )
    }
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

  it('把用户踩过的那两对单独钉住', () => {
    // 「未查询 ≠ 无记录」
    expect(DIFFERENCE_STATUS_VARIANTS.not_queried).not.toBe(DIFFERENCE_STATUS_VARIANTS.no_record)
    expect(rendered.not_queried).not.toBe(rendered.no_record)
    // 「失败 ≠ 无记录」
    expect(DIFFERENCE_STATUS_VARIANTS.query_failed).not.toBe(DIFFERENCE_STATUS_VARIANTS.no_record)
    expect(rendered.query_failed).not.toBe(rendered.no_record)
    // 「待核实 ≠ 查询失败」(原来两个都是红的)
    expect(DIFFERENCE_STATUS_VARIANTS.needs_review).not.toBe(DIFFERENCE_STATUS_VARIANTS.query_failed)
    expect(rendered.needs_review).not.toBe(rendered.query_failed)
    // 两个「已确认」也分得开
    expect(DIFFERENCE_STATUS_VARIANTS.confirmed_no_diff).not.toBe(
      DIFFERENCE_STATUS_VARIANTS.confirmed_reason,
    )
    expect(rendered.confirmed_no_diff).not.toBe(rendered.confirmed_reason)
  })

  it('六态用的变体确实是六个不同的视觉族(底色 / 线型 / 字重各有所差)', () => {
    // 逐对检查「至少差在一个通道上」:有底色 vs 无底色、红/蓝/灰、虚线 vs 实线。
    const v = DIFFERENCE_STATUS_VARIANTS
    const filled = (variant: string) => {
      const cls = badgeVariants({ variant: variant as never })
      // 有底色 = 带 bg-*(排除 bg-transparent)
      return /(^|\s)bg-(?!transparent)/.test(cls)
    }
    const dashed = (variant: string) => badgeVariants({ variant: variant as never }).includes('border-dashed')

    // 三个「有底色」的彼此靠色相分开:红 / 灰 / 主色
    expect([filled(v.query_failed!), filled(v.confirmed_no_diff!), filled(v.confirmed_reason!)]).toEqual([
      true,
      true,
      true,
    ])
    expect(new Set([v.query_failed, v.confirmed_no_diff, v.confirmed_reason]).size).toBe(3)
    // 三个「无底色」的靠线型与字重分开:虚线 / 实线深字 / 加粗框
    expect([filled(v.not_queried!), filled(v.no_record!), filled(v.needs_review!)]).toEqual([
      false,
      false,
      false,
    ])
    expect(dashed(v.not_queried!)).toBe(true)
    expect(dashed(v.no_record!)).toBe(false)
    expect(new Set([v.not_queried, v.no_record, v.needs_review]).size).toBe(3)
  })
})
