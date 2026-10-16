/**
 * **首次认定的标注**(契约 §6.1–§6.3、§7.5;issue #8)—— 纯函数,不碰库。
 *
 * ── 口径(一句话)─────────────────────────────────────────────────────────
 * 首次认定 = 该(**企业 × 称号**)下**最早的那次 `award`**;复核通过不是新的首次认定,
 * **复核失败后再次获批也不重置**。年份本身由 `computeTitleLifecycle` 算(唯一一处),
 * 本文件只负责把它**标成一个可以据以行动的结论**:
 *
 *  - `confirmed` —— 年份、事件、出处都在,这条首次认定可以拿去做补贴口径;
 *  - `pending`   —— 标了「待确认」,并给出**具体原因**。三种,互不等价:
 *      · `no_dated_award` 有一条认定但一条都定不了年 ⇒ **年份留空**(不猜一个假年份);
 *      · `undated_award`  已知最早那条定得了年,但**还有更早的认定定不了年**
 *        ⇒ 年份照给,只是**不声称它是首次**(这正是 issue #8 第 3 条要防的误标);
 *      · `no_evidence`    年份有了,可那条认定**没有存下来的出处** ⇒ 依据回不到出处,
 *        也就无从核对「首次」。
 *
 * ── 为什么「没有出处」也算待确认 ─────────────────────────────────────────
 * 票面要求首次认定的依据**必须可回到出处**(哪个文件、哪个附件、哪个序号)。
 * 一个指不回任何原始记录的年数字,和「证据不足」是同一种状态 —— 按仓库既有口径
 * (「证据不足留空并标待核,绝不猜填」)标待确认,而不是照常显示成一个确定的年份。
 *
 * ── 与「锚点待核」是两件事 ──────────────────────────────────────────────
 * `TitleLifecycle.needsReview` 说的是**复核锚点**用到了缺 `decided_year` 的事件
 * (契约 §6.4)。首次认定的年份看的是 `award` 自己的年份,**不共用那个标志** ——
 * 把两件事并成一个标,读的人就分不清「这个年份存疑」还是「下次到期存疑」。
 */
import type { TitleLifecycle } from './lifecycle'

/** 首次认定的两态。 */
export const FIRST_RECOGNITION_STATUSES = ['confirmed', 'pending'] as const
export type FirstRecognitionStatus = (typeof FIRST_RECOGNITION_STATUSES)[number]

/**
 * 待确认的原因。**顺序即优先级**:三条同时成立时报最靠前的那个
 * (判据确定,不随实现顺序变 —— 同一条数据每次给出的原因都一样)。
 */
export const FIRST_RECOGNITION_PENDING_REASONS = [
  'no_dated_award',
  'undated_award',
  'no_evidence',
] as const
export type FirstRecognitionPendingReason = (typeof FIRST_RECOGNITION_PENDING_REASONS)[number]

/** 出处 —— 与 `record_evidence` 同形状(文件 / 附件 / 序号 / 页)。 */
export interface FirstRecognitionEvidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

/**
 * 判定要用到的那部分事件(带**所在记录**的来源)。
 *
 * 字段是 `LifecycleEvent` 的超集 —— 这样同一批事件可以**原样**喂给
 * `computeTitleLifecycle` 与本判定,中间不需要一次造型(造型是「两边其实不是同一批数据」
 * 的第一个信号,这里确实就是同一批)。
 */
export interface RecognitionEvent {
  id: number
  eventType: string
  year: number | null
  decidedYear: number | null
  reviewOutcome: string | null
  /** 该事件所在记录的来源(`jxj` / `miit`,契约 §1)。 */
  source: string
}

/** 一个(**企业 × 称号**)的首次认定。 */
export interface RecognitionEntry {
  titleCode: string
  /** 已知最早那条认定的年份;没有认定、或一条都定不了年时为 `null`(不猜)。 */
  firstYear: number | null
  /** 那条认定事件 id;`null` = 给不出年份,也就指不出是哪一条。 */
  firstEventId: number | null
  /** 那条认定所在记录的来源(契约 §6.1 的「数据源」);`null` 同 `firstEventId`。 */
  source: string | null
  status: FirstRecognitionStatus
  /** `status === 'pending'` 时必非空;否则为 `null`。 */
  pendingReason: FirstRecognitionPendingReason | null
  /**
   * `firstEventId` 那条事件的**全部**出处(按 id 升序)。
   * 空数组 = **没有存下来的出处**(⇒ `pendingReason = 'no_evidence'`)。
   */
  evidence: FirstRecognitionEvidence[]
  /** 该称号下定不了年的 `award` 事件 id(升序)= 「首次可能更早」的原始依据。 */
  undatedAwardIds: number[]
}

/** 判定所需的生命周期字段(全是 `computeTitleLifecycle` 的输出,不另算一遍)。 */
export type RecognitionLifecycle = Pick<
  TitleLifecycle,
  'firstRecognitionYear' | 'firstRecognitionEventId' | 'awardCount' | 'undatedAwardIds'
>

export interface JudgeFirstRecognitionInput {
  titleCode: string
  lifecycle: RecognitionLifecycle
  /** 该(企业 × 称号)下的**全部**事件(含复核/维护/培育;判定只看 award)。 */
  events: readonly RecognitionEvent[]
  /** 事件的出处,按事件 id 索引。 */
  evidenceByEvent: ReadonlyMap<number, readonly FirstRecognitionEvidence[]>
}

/**
 * 判一条(企业 × 称号)的首次认定。
 *
 * 返回 `null` 当且仅当该称号**一次 `award` 都没有**(从没认定过 —— 那就没有「首次认定」
 * 这回事,而不是「首次认定待确认」)。有认定但定不了年**仍然出行**,只是标待确认。
 */
export function judgeFirstRecognition(
  input: JudgeFirstRecognitionInput,
): RecognitionEntry | null {
  const { titleCode, lifecycle, events, evidenceByEvent } = input
  if (lifecycle.awardCount === 0) return null

  const firstEventId = lifecycle.firstRecognitionEventId
  const firstEvent = firstEventId == null ? null : events.find((e) => e.id === firstEventId) ?? null
  const evidence = firstEventId == null ? [] : [...(evidenceByEvent.get(firstEventId) ?? [])]

  const pendingReason: FirstRecognitionPendingReason | null =
    lifecycle.firstRecognitionYear == null
      ? 'no_dated_award'
      : lifecycle.undatedAwardIds.length > 0
        ? 'undated_award'
        : evidence.length === 0
          ? 'no_evidence'
          : null

  return {
    titleCode,
    firstYear: lifecycle.firstRecognitionYear,
    firstEventId,
    // 年份给不出时**不**报来源:来源说的是「这个年份出自哪一侧」,没有年份就没有它。
    source: lifecycle.firstRecognitionYear == null ? null : firstEvent?.source ?? null,
    status: pendingReason == null ? 'confirmed' : 'pending',
    pendingReason,
    evidence,
    undatedAwardIds: [...lifecycle.undatedAwardIds],
  }
}
