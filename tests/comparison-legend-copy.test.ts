import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DIFFERENCE_COLUMN_HINT,
  DIFFERENCE_LEGEND_NOTE,
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
    // 当前可见接口证据列头为「平台记录」,不是浮层里的一段内容。
    expect(COMPARISON_SRC, '接口证据所在的可见列头应为「平台记录」').toMatch(/>\s*平台记录\s*</)
  })

  it('文案说的「可展开」方式,组件真的都接了', () => {
    // HoverCardTrigger 处理 hover 与 focus;原生按钮承接键盘和点击。
    expect(DIFFERENCE_LEGEND_NOTE).toContain('悬停')
    expect(DIFFERENCE_LEGEND_NOTE).toContain('键盘聚焦')
    expect(DIFFERENCE_LEGEND_NOTE).toContain('点按')
    expect(RECONCILE_SRC).toContain('<HoverCardTrigger as-child>')
    expect(RECONCILE_SRC).toMatch(/<button[\s\S]*@focus="open = true"/)
    expect(RECONCILE_SRC).toMatch(/@click=/)
    expect(RECONCILE_SRC).toMatch(/@keydown\.esc="open = false"/)
  })
})

describe('平台记录详情 ↔ 可见按钮和 Dialog 交互', () => {
  it('不再声称「悬停」可展开 —— 这个组件根本没有浮层', () => {
    // 组件侧的真值:详情由 Dialog 打开,没有 Tooltip / Popover。
    expect(PLATFORM_EVIDENCE_SRC).not.toMatch(/<Tooltip|<Popover/)
  })

  it('DialogTrigger 包住原生按钮,按钮文案和弹窗标题对应平台记录', () => {
    expect(PLATFORM_EVIDENCE_SRC).toContain('<DialogTrigger as-child>')
    expect(PLATFORM_EVIDENCE_SRC).toMatch(/<button type="button" data-testid="platform-evidence-details-toggle"[\s\S]*查看平台记录<\/button>/)
    expect(PLATFORM_EVIDENCE_SRC).toContain('data-testid="platform-records-dialog"')
    expect(PLATFORM_EVIDENCE_SRC).toMatch(/<DialogTitle[^>]*>平台记录<\/DialogTitle>/)
  })

  it('引用的名称与屏幕上的字一致', () => {
    // 文档细节可在弹窗内查看,列头与按钮使用页面上的实际文案。
    expect(COMPARISON_SRC).toMatch(/>\s*平台记录\s*</)
    expect(PLATFORM_EVIDENCE_SRC).toContain('查看平台记录')
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
