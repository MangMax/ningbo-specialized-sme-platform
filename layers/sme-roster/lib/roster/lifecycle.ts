import { adjudicateQualificationCycles } from './qualification-cycles'

/**
 * 名录**生命周期**的判定(契约 §6)——纯函数,不碰库。
 *
 * 这是读侧多个入口共享的**唯一一处**计算:企业总表/详情、首次认定查询和通用记录查询的
 * `dueYear` 筛选都复用这一份,不各写一遍
 * (写两遍必然漂移,而「首次认定是哪年」正是三年复核规则的地基)。
 *
 * 六条语义逐字来自契约 §6 与 ADR-2026-10-16 的 §4:
 *
 *  1. **首次认定** = 该(企业 × 称号)下**最早的 `award` 事件**年份;
 *  2. **复核通过不算新的首次认定**(首次只看 `award`);
 *  3. **复核未通过后再次获批也不重置首次认定** —— 仍是最早那条 `award`;
 *  4. **复核锚点** = 当前原认定周期最近一次「授予/延续有效资格」的年份;
 *     只有周期恢复/终止与缺口裁定明确后才输出到期年份;
 *     **下一次到期 = 锚点 + 3**;
 *  5. **未通过的复核终止当前有效资格** —— 之后没有新的 `award` 就不再进入复核队列;
 *  6. **`nurture`(入库培育)不构成称号**,不参与首次认定与复核清单。
 *
 * ── 「待核」而不是「猜」──────────────────────────────────────────────────
 * award 缺 decided_year 可沿用认定 year 并标待核；review 不能拿原认定年冒充结论年。
 * 复核日期/批次/结论或恢复顺序未知时 dueYear 留空并置 needsReview：**空值优于错误值**,
 * 更优于一个看起来很确定的错年份(契约 §1.1、ADR §5)。
 */

/** 事件类型,与 `record_event.event_type` 取值一致。 */
export type RosterEventType = 'award' | 'review' | 'maintain' | 'nurture'

/** 生命周期计算需要的最小事件形状(`record_event` 的子集)。 */
export interface LifecycleEvent {
  id: number
  /** 来源批次；未提供时仍为未知，不推断。 */
  batchSeq?: number | null
  eventType: string
  /** 事件**所涉**年份:认定事件的认定年份;复核事件记的是**被复核的原认定年份**。 */
  year: number | null
  /** 结论年份；复核缺失时不拿原认定年冒充。 */
  decidedYear: number | null
  /** 复核结论:`passed` / `failed` / `null`(不适用或未知)。 */
  reviewOutcome: string | null
}

/** 该事件是否为「正式认定 / 复核」事件(`nurture` 不算 —— 契约 §6.6)。 */
export function isQualifyingEvent(event: LifecycleEvent): boolean {
  return event.eventType === 'award' || event.eventType === 'review'
}

/**
 * 事件的**有效年份**:优先结论年份,缺失时退回所涉年份。
 * 两个都没有 ⇒ `null`(该事件不参与任何「最早/最近」的比较,也不冒充某一年)。
 */
export function effectiveYear(event: LifecycleEvent): number | null {
  return event.decidedYear ?? event.year ?? null
}

/** 事件是否缺 `decided_year`(⇒ 用到它就必须标待核)。 */
export function lacksDecidedYear(event: LifecycleEvent): boolean {
  return event.decidedYear == null
}

export type QualificationState =
  /** 无可确立的资格；needsReview 区分事实未决与从无正式事件。 */
  | 'none'
  /** 计划周期已确立且未被终止；不代表执行时点仍有效。 */
  | 'active'
  /** 已被未通过的复核终止,且之后没有新的认定。 */
  | 'terminated'

export interface TitleLifecycle {
  /** 首次认定年份(最早的 `award`);没有 `award` 时为 `null`。 */
  firstRecognitionYear: number | null
  /** 首次认定所依据的那条事件 id(供 #8 的 `firstEventId` 复用)。 */
  firstRecognitionEventId: number | null
  /**
   * 该(企业 × 称号)下 `award` 事件的条数(RL-08 增量)。
   *
   * 首次认定读模型靠它区分两件长得一样、含义完全不同的事:
   * `awardCount === 0`(这个称号**从来没认定过**)与「有认定但一条都定不了年」。
   * 前者连一行首次认定都不该有;后者必须**留空并标待确认**(契约 §6.1、issue #8)。
   */
  awardCount: number
  /**
   * **定不了年**的 `award` 事件 id(升序,RL-08 增量)。
   *
   * `year` 与 `decided_year` 都空的现存认定事件无法参与年份比较。若数据库里有这种记录,
   * 首次年份需标待确认;这里给出具体事件 id,不把缺年份与整条事件未入库混为一谈。
   *
   * 只看 `award`:复核事件定不了年不影响「首次认定是哪年」。
   */
  undatedAwardIds: number[]
  /** 复核锚点年份(最近一次授予/延续有效资格的年份);没有候选时为 `null`。 */
  anchorYear: number | null
  /** 锚点所依据的那条事件 id(供 #9 的 `basisEventId` 复用)。 */
  anchorEventId: number | null
  /** 下一次到期 = 锚点 + 3;无锚点或资格已终止时为 `null`。 */
  dueYear: number | null
  /** 计划周期状态；当前有效资格另按执行时点裁定。 */
  state: QualificationState
  /** 当前周期恢复、终止或日期/批次/结论未决，或认定锚点缺 decidedYear ⇒ 待核。 */
  needsReview: boolean
}

/** 按「有效年份 → id」升序排;有效年份缺失的排最后(它无从参与比较)。 */
function chronological(events: LifecycleEvent[]): LifecycleEvent[] {
  return [...events].sort((a, b) => {
    const ya = effectiveYear(a)
    const yb = effectiveYear(b)
    if (ya == null && yb == null) return a.id - b.id
    if (ya == null) return 1
    if (yb == null) return -1
    return ya - yb || a.id - b.id
  })
}

/** 首次认定计算的四项事实,不计算复核锚点或当前资格。 */
export type FirstAwardFacts = Pick<TitleLifecycle,
  'firstRecognitionYear' | 'firstRecognitionEventId' | 'awardCount' | 'undatedAwardIds'>

/** 接受完整历史;只有 award 参与,沿用生命周期的有效年份与排序规则。 */
export function computeFirstAward(events: LifecycleEvent[]): FirstAwardFacts {
  return firstAwardFacts(events.filter((e) => e.eventType === 'award'))
}

// 完整生命周期已需 awards 供锚点使用,复用该数组,避免再次筛选。
function firstAwardFacts(awards: LifecycleEvent[]): FirstAwardFacts {
  // ① 首次认定 = 最早的 award(按有效年份,同年按 id)。复核事件一概不参与。
  const earliestAward = chronological(awards).find((e) => effectiveYear(e) != null)
  const firstRecognitionYear = earliestAward ? effectiveYear(earliestAward) : null
  // 定不了年的 award:它们不参与上面的比较,但**可能更早** ⇒ 首次认定据此标待确认。
  const undatedAwardIds = awards
    .filter((e) => effectiveYear(e) == null)
    .map((e) => e.id)
    .sort((a, b) => a - b)

  return {
    firstRecognitionYear,
    firstRecognitionEventId: earliestAward?.id ?? null,
    awardCount: awards.length,
    undatedAwardIds,
  }
}

/**
 * 算一个(企业 × 称号)的生命周期。传进来的事件**可以是该企业全部事件**
 * —— maintain/nurture 不参与；正式事件的未知年份/批次/结论保留待核。
 */
export function computeTitleLifecycle(events: LifecycleEvent[]): TitleLifecycle {
  const awards = events.filter((e) => e.eventType === 'award')

  const firstAward = firstAwardFacts(awards)

  // Planning and current eligibility share originating-year/batch recovery and
  // gap adjudication. Planning keeps overdue cycles; only current eligibility
  // applies an execution-year expiry cutoff. A pass never acts as a new grant.
  const formal = events.filter(isQualifyingEvent).map(e => ({ ...e, batchSeq: e.batchSeq ?? null }))
  const judgment = adjudicateQualificationCycles(formal)
  const anchors = judgment.cycles.flatMap(c => c.anchor ? [c.anchor] : [])
  const lastAnchor = chronological(anchors).at(-1) ?? null
  const anchorYear = lastAnchor ? effectiveYear(lastAnchor) : null
  const state: QualificationState = judgment.group === 'excluded' ? 'terminated'
    : judgment.group === 'eligible' ? 'active' : 'none'
  const needsReview = (formal.length > 0 && judgment.group === 'pending')
    || anchors.some(lacksDecidedYear)

  return {
    ...firstAward,
    anchorYear,
    anchorEventId: lastAnchor?.id ?? null,
    dueYear: anchorYear != null && state === 'active' ? anchorYear + 3 : null,
    state,
    needsReview,
  }
}
