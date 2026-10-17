import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DIFFERENCE_COLUMN_HINT,
  DIFFERENCE_LEGEND_NOTE,
  RECONCILE_LEGEND_NOTE,
} from '../lib/labels'

/**
 * 比对页图例那句说明 —— **它描述的东西必须真的存在**。
 *
 * 这句话连着被盲测挑中两次,两次都是同一类毛病:**承诺了页面上没有的东西**。
 *
 *  1. 第一版说「悬停、键盘聚焦或点按可展开原因、配对措施与**接口证据**」。它印在**图例**那一排
 *     徽章下面,读起来像在说这些徽章;而可展开的那一枚在**表里**,浮层里也**没有**接口证据
 *     —— 证据在隔壁「平台证据」那一列。
 *  2. 第二版把列名写成「平台**原因**」,而列头叫「平台**解释**」,用户按字面**找不到那一列**。
 *
 * 所以这里对**两个对象**各钉一条:文案 ↔ 列头(名称)、文案 ↔ 浮层(内容)。
 * 列头那一侧的真值在真实 DOM 里(`pnpm verify:ledger-ui` 会拿渲染出来的 `thead th` 比对);
 * 这里守的是**常量本身的措辞**,以及它跟组件模板对不对得上 —— 纯读源码,不引浏览器。
 */

const RECONCILE_SRC = readFileSync(
  new URL('../components/ComparisonReconcile.vue', import.meta.url),
  'utf8',
)
const COMPARISON_SRC = readFileSync(new URL('../pages/comparison.vue', import.meta.url), 'utf8')
const PLATFORM_EVIDENCE_SRC = readFileSync(
  new URL('../components/ComparisonPlatformEvidence.vue', import.meta.url),
  'utf8',
)

/** 浮层里实际会出现的四段(顺序也是这个)。 */
const POPOVER_FIELDS = ['原因', '后续措施', '迁入来源', '核验']

describe('图例说明 ↔ 浮层内容', () => {
  it('文案承诺的浮层内容,组件里真的有这四段', () => {
    for (const field of POPOVER_FIELDS) {
      expect(RECONCILE_SRC, `浮层里找不到「${field}」`).toContain(field)
      expect(DIFFERENCE_LEGEND_NOTE, `文案没提浮层里的「${field}」`).toContain(field)
    }
  })

  it('浮层里**没有**接口证据 —— 所以文案不许说浮层能展开它', () => {
    // 这条是上一轮的原始缺陷:文案说浮层展开「接口证据」,而浮层里根本没有。
    expect(RECONCILE_SRC, '浮层里出现了「接口证据」,文案的措辞要跟着改').not.toContain('接口证据')
    // 而文案把证据指到隔壁那一列(该列是真实存在的列头)。
    expect(DIFFERENCE_LEGEND_NOTE).toContain('平台证据')
    expect(COMPARISON_SRC, '「平台证据」列头不在了,文案指向就落空').toContain('平台证据')
  })

  it('文案说的「可展开」方式,组件真的都接了', () => {
    // 悬停 / 键盘 / 点按三种:reka 的 Tooltip 给悬停与聚焦,组件自己接 click 与 keydown。
    expect(DIFFERENCE_LEGEND_NOTE).toContain('悬停')
    expect(DIFFERENCE_LEGEND_NOTE).toContain('键盘聚焦')
    expect(DIFFERENCE_LEGEND_NOTE).toContain('点按')
    expect(RECONCILE_SRC).toMatch(/@click=/)
    expect(RECONCILE_SRC).toMatch(/@keydown=/)
    expect(RECONCILE_SRC).toMatch(/tabindex="0"/)
  })
})

describe('平台证据图例说明 ↔ 组件实际行为', () => {
  /**
   * 这条是「一起收」的那半句(父代理 2026-10-16 裁决):与上面 `DIFFERENCE_LEGEND_NOTE` 同类毛病 ——
   * 图例描述了组件里不存在的行为。
   *
   * ⚠️ 如实记一笔:`RECONCILE_LEGEND_*` 这一组常量**目前没有任何地方引用**(连测试都没有),
   * 所以这几条断言守的是一句**不渲染在页面上**的文案 —— 它的价值在于:哪天旧图例被重新接上,
   * 不会把错话一起带回来。真要清干净,应该按 `lib/labels.ts` 里那条退役注释整组删掉。
   *
   * 实测 `components/ComparisonPlatformEvidence.vue`:没有 Tooltip/Popover;只有一个
   * `<button>`「展开原始关系(N 条)」;登记位置与取数时间是直接印在单元格里的。
   */
  const NOTE = RECONCILE_LEGEND_NOTE

  it('不再声称「悬停」可展开 —— 这个组件根本没有浮层', () => {
    expect(NOTE).not.toContain('悬停')
    // 组件侧的真值:没有 Tooltip / Popover,所以「悬停」无论如何都不成立。
    expect(PLATFORM_EVIDENCE_SRC).not.toMatch(/<Tooltip|<Popover/)
  })

  it('不再声称可展开登记位置 / 取数时间;它们直接显示在单元格里', () => {
    // 「登记位置」根本不是这个单元格里的字,不该出现在文案里。
    expect(NOTE).not.toContain('登记位置')
    // 取数时间可以说 —— 但必须是「**直接给出**」的说法,不能挂在「展开」后面。
    if (NOTE.includes('取数时间')) {
      expect(NOTE, '取数时间是直接显示的,不是展开出来的').toContain('直接')
      expect(NOTE).not.toMatch(/展开[^。]*取数时间/)
    }
  })

  it('唯一真交互(展开原始关系)在组件里接得上,并且是点按 + 键盘都能用', () => {
    expect(NOTE).toContain('展开原始关系')
    // 按钮只在有关系时出现,文案说的是「要点按钮」,与 v-if="relationTotal" 一致。
    expect(PLATFORM_EVIDENCE_SRC).toContain('展开原始关系')
    expect(PLATFORM_EVIDENCE_SRC).toMatch(/<button[\s\S]{0,300}@click=/)
    // 原生 <button> 本身就带键盘可达性(Enter / Space),与文案的「点按或键盘都可以」相符。
    expect(PLATFORM_EVIDENCE_SRC).not.toMatch(/<div[^>]*@click=[^>]*展开原始关系/)
    expect(NOTE).toContain('点按')
    expect(NOTE).toContain('键盘')
  })

  it('引用的名称与屏幕上的字一致', () => {
    // 「平台证据」是列头(上面那组断言已经对过 comparison.vue),「展开原始关系」是按钮文案。
    expect(NOTE).toContain('平台证据')
    expect(PLATFORM_EVIDENCE_SRC).toContain('展开原始关系')
    expect(NOTE).toContain('曾用名')
    expect(PLATFORM_EVIDENCE_SRC).toContain('曾用名')
  })
})

describe('图例说明 ↔ 列名(统一到列头那个词)', () => {
  it('两个常量都说「平台解释」,不说「平台原因」', () => {
    /**
     * 为什么统一到「平台解释」而不是「平台原因」:
     *  - 列头写的就是「平台解释」(`pages/comparison.vue`)——**用户在屏幕上真正看到的那个词**,
     *    文案要按字面能对上,否则等于让用户去找一个不存在的列;
     *  - 领域语言同样是「解释」:契约把这一组读接口叫「差异与解释」,仓库里
     *    `RECONCILE_SOURCE`(「平台解释的取数来源」)也一直用「平台解释」;
     *    `difference_reason` 只是**表名**,不该出现在给用户看的句子里。
     */
    expect(DIFFERENCE_LEGEND_NOTE).toContain('平台解释')
    expect(DIFFERENCE_COLUMN_HINT).toContain('平台解释')
    expect(DIFFERENCE_LEGEND_NOTE).not.toContain('平台原因')
    expect(DIFFERENCE_COLUMN_HINT).not.toContain('平台原因')
  })

  it('「平台解释」确实是这一页的列头(源码里对得上)', () => {
    expect(COMPARISON_SRC).toMatch(/>\s*平台解释\s*</)
  })
})
