import { describe, expect, it } from 'vitest'
import {
  computeTitleLifecycle,
  effectiveYear,
  isQualifyingEvent,
  type LifecycleEvent,
} from '../lib/roster/lifecycle'

/**
 * 契约 §6 的生命周期语义 —— 纯函数层。
 *
 * 每条用例都对着**文档里写死的那个例子**(契约 §6、ADR §4、00-CONTEXT「关键回归案例」),
 * 期望值是文档给的数字,不是照代码推的:
 *  - 2021 认定 → 2024 复核**通过** ⇒ 锚点 2024,下一次到期 **2027**(ADR §9);
 *  - 2021 认定 → 2024 复核**未通过** → 2025 再次获批 ⇒ 首次仍是 **2021**,锚点 **2025**,
 *    下一次到期 **2028**(契约 §6.3/§6.4 + 00-CONTEXT 回归案例);
 *  - `nurture` 不构成称号 ⇒ 首次认定与到期都为 null(契约 §6.6)。
 */

/** 造一条事件;`decidedYear` 显式传 `null` 表示「来源没给结论年份」。 */
function ev(
  id: number,
  eventType: string,
  year: number | null,
  opts: { decidedYear?: number | null; reviewOutcome?: string | null } = {},
): LifecycleEvent {
  return {
    id,
    eventType,
    year,
    decidedYear: opts.decidedYear === undefined ? year : opts.decidedYear,
    reviewOutcome: opts.reviewOutcome ?? null,
  }
}

describe('lib/roster/lifecycle —— 契约 §6 的三年复核语义', () => {
  it('首次认定 = 最早的 award 年份;复核通过不算新的首次认定', () => {
    const lc = computeTitleLifecycle([
      ev(1, 'award', 2021),
      ev(2, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'passed' }),
    ])
    expect(lc.firstRecognitionYear).toBe(2021)
    expect(lc.firstRecognitionEventId).toBe(1)
    // 锚点 = 最近一次授予/延续有效资格 = 2024 ⇒ 下一次到期 2027(ADR §9)。
    expect(lc.anchorYear).toBe(2024)
    expect(lc.anchorEventId).toBe(2)
    expect(lc.dueYear).toBe(2027)
    expect(lc.state).toBe('active')
  })

  it('复核未通过后再次获批**不重置**首次认定,但刷新锚点(2021 → 2024 未通过 → 2025 获批)', () => {
    const lc = computeTitleLifecycle([
      ev(1, 'award', 2021),
      // 被复核的原认定年份是 2021,结论发生在 2024。
      ev(2, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'failed' }),
      ev(3, 'award', 2025),
    ])
    expect(lc.firstRecognitionYear).toBe(2021)
    expect(lc.firstRecognitionEventId).toBe(1)
    // 重新获批刷新锚点 ⇒ 2025 + 3 = 2028(回归案例原话)。
    expect(lc.anchorYear).toBe(2025)
    expect(lc.dueYear).toBe(2028)
    expect(lc.state).toBe('active')
  })

  it('未通过的复核终止当前有效资格:不再进入复核队列(没有后续 award 时到期为 null)', () => {
    const lc = computeTitleLifecycle([
      ev(1, 'award', 2021),
      ev(2, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'failed' }),
    ])
    // 首次认定仍在(那是历史事实),但当前资格已终止 ⇒ 不算下一次到期。
    expect(lc.firstRecognitionYear).toBe(2021)
    expect(lc.state).toBe('terminated')
    expect(lc.dueYear).toBeNull()
  })

  it('结论未知的复核(**不是**未通过)**不终止**资格,也不算作锚点', () => {
    const lc = computeTitleLifecycle([
      ev(1, 'award', 2022),
      // 平台只说明「发生过复核」,没有结论 ⇒ review_outcome 留空,不猜成通过、也不算未通过。
      ev(2, 'review', 2022, { decidedYear: 2025, reviewOutcome: null }),
    ])
    expect(lc.state).toBe('active')
    expect(lc.anchorYear).toBe(2022)
    expect(lc.dueYear).toBe(2025)
  })

  it('nurture(入库培育)不构成称号:首次认定与到期都为 null', () => {
    const lc = computeTitleLifecycle([ev(1, 'nurture', 2023), ev(2, 'nurture', 2024)])
    expect(lc.firstRecognitionYear).toBeNull()
    expect(lc.anchorYear).toBeNull()
    expect(lc.dueYear).toBeNull()
    expect(lc.state).toBe('none')
  })

  it('decided_year 缺失 ⇒ 退回 year 并**标待核**(不猜一个看起来确定的年份)', () => {
    const lc = computeTitleLifecycle([
      ev(1, 'award', 2020, { decidedYear: null }),
      ev(2, 'review', 2020, { decidedYear: null, reviewOutcome: 'passed' }),
    ])
    // 值照给(退回 year:2020 → 锚点 2020 → 到期 2023)。
    expect(lc.firstRecognitionYear).toBe(2020)
    expect(lc.anchorYear).toBe(2020)
    expect(lc.dueYear).toBe(2023)
    // 但用的是退回来的年份,必须标待核 —— 这正是「不猜」的可观测形式。
    expect(lc.needsReview).toBe(true)
    // 有结论年份时不该标待核。
    expect(computeTitleLifecycle([ev(1, 'award', 2020)]).needsReview).toBe(false)
  })

  it('有效年份缺失的事件不参与比较,也不冒充某一年', () => {
    const lc = computeTitleLifecycle([ev(9, 'award', null, { decidedYear: null })])
    expect(lc.firstRecognitionYear).toBeNull()
    expect(lc.state).toBe('none')
    expect(effectiveYear(ev(9, 'award', null, { decidedYear: null }))).toBeNull()
    // 结论年份优先于所涉年份。
    expect(effectiveYear(ev(9, 'review', 2021, { decidedYear: 2024 }))).toBe(2024)
  })

  it('maintain / nurture 不是「正式认定/复核事件」', () => {
    expect(isQualifyingEvent(ev(1, 'award', 2020))).toBe(true)
    expect(isQualifyingEvent(ev(1, 'review', 2020))).toBe(true)
    expect(isQualifyingEvent(ev(1, 'maintain', 2025))).toBe(false)
    expect(isQualifyingEvent(ev(1, 'nurture', 2025))).toBe(false)
  })

  it('事件顺序不影响结论(同一年内按 id 定序,不依赖调用方排序)', () => {
    const events = [
      ev(3, 'award', 2025),
      ev(1, 'award', 2021),
      ev(2, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'failed' }),
    ]
    expect(computeTitleLifecycle(events)).toEqual(computeTitleLifecycle([...events].reverse()))
  })
})
