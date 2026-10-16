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
 *  4. **复核锚点** = 最近一次「授予/延续有效资格」的年份
 *     = `max(decided_year ?? year)`,对 `award` 与 `reviewOutcome='passed'` 取最大;
 *     **下一次到期 = 锚点 + 3**;
 *  5. **未通过的复核终止当前有效资格** —— 之后没有新的 `award` 就不再进入复核队列;
 *  6. **`nurture`(入库培育)不构成称号**,不参与首次认定与复核清单。
 *
 * ── 「待核」而不是「猜」──────────────────────────────────────────────────
 * `decided_year` 缺失时**退回 `year`** 并置 `needsReview`:**空值优于错误值**,
 * 更优于一个看起来很确定的错年份(契约 §1.1、ADR §5)。
 */

/** 事件类型,与 `record_event.event_type` 取值一致。 */
export type RosterEventType = 'award' | 'review' | 'maintain' | 'nurture'

/** 生命周期计算需要的最小事件形状(`record_event` 的子集)。 */
export interface LifecycleEvent {
  id: number
  eventType: string
  /** 事件**所涉**年份:认定事件的认定年份;复核事件记的是**被复核的原认定年份**。 */
  year: number | null
  /** **结论年份**;缺失时锚点退回 `year` 并标待核。 */
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
  /** 从来没有过正式认定/复核 —— 该称号下无从谈起有效期。 */
  | 'none'
  /** 当前有效:最近一次决定性事件不是「未通过的复核」。 */
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
  /** 当前资格状态。 */
  state: QualificationState
  /** 计算中用到了缺 `decided_year` 的事件(锚点退回 `year`)⇒ **待核**。 */
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

/**
 * 算一个(企业 × 称号)的生命周期。传进来的事件**可以是该企业全部事件**
 * —— `nurture` 与无有效年份的事件会被忽略,不影响结论。
 */
export function computeTitleLifecycle(events: LifecycleEvent[]): TitleLifecycle {
  const awards = events.filter((e) => e.eventType === 'award')
  const reviews = events.filter((e) => e.eventType === 'review')

  // ① 首次认定 = 最早的 award(按有效年份,同年按 id)。复核事件一概不参与。
  const earliestAward = chronological(awards).find((e) => effectiveYear(e) != null)
  const firstRecognitionYear = earliestAward ? effectiveYear(earliestAward) : null
  // 定不了年的 award:它们不参与上面的比较,但**可能更早** ⇒ 首次认定据此标待确认。
  const undatedAwardIds = awards
    .filter((e) => effectiveYear(e) == null)
    .map((e) => e.id)
    .sort((a, b) => a - b)

  // ② 锚点候选 = award ∪ `reviewOutcome='passed'` 的 review(契约 §6.4)。
  //    结论未知的复核(`reviewOutcome=null`)**不猜成通过**,因此不进候选。
  const anchors = chronological([
    ...awards,
    ...reviews.filter((e) => e.reviewOutcome === 'passed'),
  ]).filter((e) => effectiveYear(e) != null)
  const lastAnchor = anchors.at(-1) ?? null
  const anchorYear = lastAnchor ? effectiveYear(lastAnchor) : null

  // ③ 资格状态:看**决定性事件**(award 与 conclusion 明确的 review)里最后一条。
  //    最后一条是「未通过的复核」⇒ 资格被终止(§6.5);之后若又有 award,则重新有效。
  const decisive = chronological([
    ...awards,
    ...reviews.filter((e) => e.reviewOutcome === 'passed' || e.reviewOutcome === 'failed'),
  ]).filter((e) => effectiveYear(e) != null)
  const lastDecisive = decisive.at(-1) ?? null
  const terminated =
    lastDecisive != null && lastDecisive.eventType === 'review' && lastDecisive.reviewOutcome === 'failed'
  const state: QualificationState =
    anchors.length === 0 ? 'none' : terminated ? 'terminated' : 'active'

  // ④ 待核:用到的锚点事件缺结论年份,则锚点退回 `year` —— 值给出来,但**标待核**。
  const needsReview = anchors.some(lacksDecidedYear)

  return {
    firstRecognitionYear,
    firstRecognitionEventId: earliestAward?.id ?? null,
    awardCount: awards.length,
    undatedAwardIds,
    anchorYear,
    anchorEventId: lastAnchor?.id ?? null,
    dueYear: anchorYear != null && state === 'active' ? anchorYear + 3 : null,
    state,
    needsReview,
  }
}
