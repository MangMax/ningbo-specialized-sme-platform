import { describe, expect, it } from 'vitest'
import {
  computeFirstAward,
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

/**
 * RL-08 增量:把「有没有 award」与「有没有**定不了年**的 award」也算出来。
 *
 * 首次认定用得到这两件事,而它们只在这一层看得见(读模型手上只有事件):
 *  - `awardCount === 0` ⇒ 该称号从来没正式认定过,连一行首次认定都不该有;
 *  - `undatedAwardIds` 非空 ⇒ 有现存认定无法定年,不能与有年份的 award 排出先后,
 *    因而首次状态待确认。
 */
describe('lib/roster/lifecycle —— 首次认定的两条前置事实(RL-08 增量)', () => {
  it('awardCount 只数 award:复核 / 维护 / 培育都不算', () => {
    expect(computeTitleLifecycle([ev(1, 'award', 2021), ev(2, 'award', 2025)]).awardCount).toBe(2)
    expect(
      computeTitleLifecycle([
        ev(1, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'passed' }),
        ev(2, 'maintain', 2025),
        ev(3, 'nurture', 2023),
      ]).awardCount,
    ).toBe(0)
    expect(computeTitleLifecycle([]).awardCount).toBe(0)
  })

  it('undatedAwardIds 列出**定不了年**的 award(id 升序),有序 —— 它是「首次可能更早」的依据', () => {
    const lc = computeTitleLifecycle([
      ev(7, 'award', null, { decidedYear: null }),
      ev(2, 'award', null, { decidedYear: null }),
      ev(5, 'award', 2024),
    ])
    expect(lc.undatedAwardIds).toEqual([2, 7])
    // 年份照给(已知最早那条),但**不是**「首次」—— 上面两条可能更早。
    expect(lc.firstRecognitionYear).toBe(2024)
  })

  it('没有无法定年的 award 时为空数组(不是 undefined,免得调用方各判各的)', () => {
    const lc = computeTitleLifecycle([ev(1, 'award', 2020, { decidedYear: 2020 })])
    expect(lc.undatedAwardIds).toEqual([])
    // 复核定不了年**不算**「首次可能更早」——首次只看 award。
    const withUndatedReview = computeTitleLifecycle([
      ev(1, 'award', 2020),
      ev(2, 'review', 2020, { decidedYear: null, reviewOutcome: 'passed' }),
    ])
    expect(withUndatedReview.undatedAwardIds).toEqual([])
  })
})

describe('first-award facts without review lifecycle', () => {
  it('selects the earliest effective year then lowest id from shuffled and tied awards', () => {
    const events = [ev(8, 'award', 2021), ev(2, 'award', 2021),
      ev(1, 'award', 2019, { decidedYear: 2024 }), ev(9, 'award', 2025),
      ev(10, 'review', 2021, { decidedYear: 2024, reviewOutcome: 'failed' }),
      ev(11, 'maintain', 2010), ev(12, 'nurture', 2009)]
    const facts = computeFirstAward(events)
    expect(facts).toEqual({ firstRecognitionYear: 2021, firstRecognitionEventId: 2,
      awardCount: 4, undatedAwardIds: [] })
    expect(computeTitleLifecycle(events)).toEqual({ ...facts, anchorYear: 2025,
      anchorEventId: 9, dueYear: 2028, state: 'active', needsReview: false })
    expect(computeFirstAward([...events].reverse())).toEqual(facts)
  })
})

it('keeps undated awards sorted and separate from dated fallback and review uncertainty', () => {
  const events = [ev(7, 'award', null), ev(2, 'award', null),
    ev(5, 'award', 2024, { decidedYear: null }),
    ev(6, 'review', 2024, { decidedYear: null, reviewOutcome: 'passed' })]
  expect(computeFirstAward(events)).toEqual({ firstRecognitionYear: 2024,
    firstRecognitionEventId: 5, awardCount: 3, undatedAwardIds: [2, 7] })
  expect(computeTitleLifecycle(events)).toEqual({ firstRecognitionYear: 2024,
    firstRecognitionEventId: 5, awardCount: 3, undatedAwardIds: [2, 7],
    anchorYear: 2024, anchorEventId: 6, dueYear: 2027, state: 'active', needsReview: true })
  expect(computeFirstAward(events.slice(0, 2))).toEqual({ firstRecognitionYear: null,
    firstRecognitionEventId: null, awardCount: 2, undatedAwardIds: [2, 7] })
  expect(computeTitleLifecycle(events.slice(0, 2))).toEqual({ firstRecognitionYear: null,
    firstRecognitionEventId: null, awardCount: 2, undatedAwardIds: [2, 7],
    anchorYear: null, anchorEventId: null, dueYear: null, state: 'none', needsReview: false })
  expect(computeFirstAward([ev(1, 'review', 2020), ev(2, 'maintain', 2019), ev(3, 'nurture', 2018)]))
    .toEqual({ firstRecognitionYear: null, firstRecognitionEventId: null, awardCount: 0, undatedAwardIds: [] })
  expect(computeFirstAward([])).toEqual({ firstRecognitionYear: null,
    firstRecognitionEventId: null, awardCount: 0, undatedAwardIds: [] })
})
