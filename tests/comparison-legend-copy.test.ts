import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const COMPARISON_SRC = readFileSync(new URL('../pages/comparison.vue', import.meta.url), 'utf8')
const RECONCILE_SRC = readFileSync(new URL('../components/ComparisonReconcile.vue', import.meta.url), 'utf8')
const PLATFORM_EVIDENCE_SRC = readFileSync(
  new URL('../components/ComparisonPlatformEvidence.vue', import.meta.url),
  'utf8',
)

describe('比对页减法与证据展开', () => {
  it('保留平台解释与平台证据列,移除常驻图例和横向滚动说明', () => {
    expect(COMPARISON_SRC).toMatch(/>\s*平台解释\s*</)
    expect(COMPARISON_SRC).toMatch(/>\s*平台证据\s*</)
    expect(COMPARISON_SRC).not.toContain('platform-legend')
    expect(COMPARISON_SRC).not.toContain('scroll-hint')
    expect(COMPARISON_SRC).not.toContain('DIFFERENCE_LEGEND_NOTE')
  })

  it('每行先显示紧凑状态摘要,完整查询与原始关系仍可点开', () => {
    expect(PLATFORM_EVIDENCE_SRC).toContain('platform-evidence-summary')
    expect(PLATFORM_EVIDENCE_SRC).toContain('PLATFORM_QUERY_STATUSES[status]')
    expect(PLATFORM_EVIDENCE_SRC).toContain('platform-evidence-details-toggle')
    expect(PLATFORM_EVIDENCE_SRC).toContain('platform-evidence-toggle')
    expect(PLATFORM_EVIDENCE_SRC).toContain('data-testid="platform-relation"')
  })

  it('平台解释用原生按钮触发原因提示,保留键盘和触屏可达性', () => {
    expect(RECONCILE_SRC).toContain('data-testid="reconcile-status-trigger"')
    expect(RECONCILE_SRC).toMatch(/<button[\s\S]{0,100}type="button"/)
    expect(RECONCILE_SRC).toMatch(/@click="onClick"/)
    expect(RECONCILE_SRC).toMatch(/@pointerdown="onPointerDown"/)
    expect(RECONCILE_SRC).not.toContain('Badge')
    expect(RECONCILE_SRC).toContain('原因:')
    expect(RECONCILE_SRC).toContain('后续措施:')
  })
})
