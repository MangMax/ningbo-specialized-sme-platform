/**
 * **首次认定的标注**(契约 §6.1–§6.3、§7.5;issue #8)—— 纯函数,不碰库。
 *
 * ── 口径(一句话)─────────────────────────────────────────────────────────
 * 首次认定 = 该(**企业 × 称号**)下**最早的那次 `award`**;复核通过不是新的首次认定,
 * **复核失败后再次获批也不重置**。年份本身由 `computeTitleLifecycle` 算(唯一一处),
 * 本文件只负责把它**标成一个可以据以行动的结论**:
 *
 *  - `confirmed` —— 年份、事件、出处都在,这条首次认定可以拿去做补贴口径;
 *  - `pending`   —— 标了「待确认」,并给出**具体原因**。三种,互不等价,都对应数据库中现存 award 的字段异常:
 *      · `no_dated_award` 有一条认定但一条都定不了年 ⇒ **年份留空**(不猜一个假年份);
 *      · `undated_award`  有 award 缺有效年份,同时还有可定年的 award ⇒ 年份照给并标待确认;
 *      · `no_evidence`    年份有了,可那条认定**没有存下来的出处** ⇒ 依据回不到出处,
 *        也就无从核对「首次」。
 *
 * 整条历史事件的入库完整性由清理入库验收负责;首次计算只处理数据库中的事件,不推断未入库事件。
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
import { isPageCapable } from '../../../../lib/roster/evidence-page'

/**
 * 首次认定的两态。
 *
 * 名字带 `_VALUES`:中文标签表在 `layers/sme-roster/lib/labels.ts` 里叫 `FIRST_RECOGNITION_STATUSES`
 * (与 `DIFFERENCE_STATUSES` / `VERIFICATION_STATUSES` 同一命名),同仓的
 * `PLATFORM_INTERFACE_VALUES`↔`PLATFORM_INTERFACES` 就是这么分的。**两处同名会逼着调用方
 * 起别名**,别名一起就没人分得清哪个是取值、哪个是文案。
 */
export const FIRST_RECOGNITION_STATUS_VALUES = ['confirmed', 'pending'] as const
export type FirstRecognitionStatus = (typeof FIRST_RECOGNITION_STATUS_VALUES)[number]

/**
 * 待确认的原因。**顺序即优先级**:三条同时成立时报最靠前的那个
 * (判据确定,不随实现顺序变 —— 同一条数据每次给出的原因都一样)。
 */
export const FIRST_RECOGNITION_PENDING_REASON_VALUES = [
  'no_dated_award',
  'undated_award',
  'no_evidence',
] as const
export type FirstRecognitionPendingReason =
  (typeof FIRST_RECOGNITION_PENDING_REASON_VALUES)[number]

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
 * 这回事,而不是「首次认定待确认」)。有 award 但缺有效年份时仍出行,并标记待确认。
 */
export function judgeFirstRecognition(
  input: JudgeFirstRecognitionInput,
): RecognitionEntry | null {
  const evidence = input.lifecycle.firstRecognitionEventId == null ? []
    : [...(input.evidenceByEvent.get(input.lifecycle.firstRecognitionEventId) ?? [])]
  const summary = summarizeFirstRecognition({ ...input, hasEvidence: evidence.length > 0 })
  return summary ? { ...summary, evidence } : null
}

/** Same domain decision for bounded reads: evidence existence is enough to
 * classify a pair; complete pointers are hydrated only for the requested page. */
export function summarizeFirstRecognition(
  input: Omit<JudgeFirstRecognitionInput, 'evidenceByEvent'> & { hasEvidence: boolean },
): Omit<RecognitionEntry, 'evidence'> | null {
  const { titleCode, lifecycle, events, hasEvidence } = input
  if (lifecycle.awardCount === 0) return null

  const firstEventId = lifecycle.firstRecognitionEventId
  const firstEvent = firstEventId == null ? null : events.find((e) => e.id === firstEventId) ?? null

  const pendingReason: FirstRecognitionPendingReason | null =
    lifecycle.firstRecognitionYear == null
      ? 'no_dated_award'
      : lifecycle.undatedAwardIds.length > 0
        ? 'undated_award'
        : !hasEvidence
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
    undatedAwardIds: [...lifecycle.undatedAwardIds],
  }
}

// ---------------------------------------------------------------------------
// 筛选判据 —— **只有这一处**
// ---------------------------------------------------------------------------

/**
 * 首次认定的四个判据(`title` / `firstYear` / `firstStatus` 三者 + 由它们共同约束的「同一个称号」)。
 *
 * 为什么把判据抽到这里,而不是在「企业总表」与「首次认定清单」里各写一遍:
 * 两个读模型看的是**同一批** `RecognitionEntry`。判据各写一份,迟早一边加了新条件、
 * 另一边没加,于是「总表筛出 3 家、首次认定清单筛出 5 家」—— 而这两个数在页面上是并排给人看的。
 * 契约 §7.5.1 说它们取同一处计算,这条判据也是同一处的一部分。
 */
export interface RecognitionQuery {
  /** 称号(多值,命中任一);给了就要求后面几项**落在同一个称号**上。 */
  title?: string[]
  /** **首次认定年份**(多值,命中任一)。 */
  firstYear?: number[]
  /** 首次认定状态(多值,命中任一)。 */
  firstStatus?: string[]
}

/**
 * 这条首次认定是否命中判据。没给的项不参与(「没筛」与「筛了个空」是两回事)。
 *
 * 年份给不出(`firstYear == null`)时**命中不了任何年份**:留空是「未知」,
 * 不该被当成某个具体年份的匹配。
 */
export function matchesRecognitionQuery(
  entry: Pick<RecognitionEntry, 'titleCode' | 'firstYear' | 'status'>,
  query: RecognitionQuery,
): boolean {
  const titles = query.title?.length ? query.title : null
  const years = query.firstYear?.length ? query.firstYear : null
  const statuses = query.firstStatus?.length ? query.firstStatus : null
  if (titles && !titles.includes(entry.titleCode)) return false
  if (years && (entry.firstYear == null || !years.includes(entry.firstYear))) return false
  if (statuses && !statuses.includes(entry.status)) return false
  return true
}

// ---------------------------------------------------------------------------
// 展示用的两句话 —— **三处共用一处**
// ---------------------------------------------------------------------------

/**
 * 年份给不出时的显示文案。
 *
 * 三处(导出、台账表、展开面板)都要写它;各写一个字面量的话,改一处就会漏另一处,
 * 而漏掉的那处会给读者一个**看起来像年份**的东西 —— 那正是这一票要防的。
 */
export const FIRST_RECOGNITION_UNKNOWN_YEAR = '年份未知'

/** 首次认定那一项的年份文案:有年份给年份,没有就明说「年份未知」,不填空、不填别的年份。 */
export function firstRecognitionYearText(entry: { firstYear: number | null }): string {
  return entry.firstYear == null ? FIRST_RECOGNITION_UNKNOWN_YEAR : String(entry.firstYear)
}

/**
 * 一处出处的写法:文件 · 附件 · 序号 · 页 —— **缺哪样就不写哪样**,不填占位符。
 *
 * 同样三处共用:票面要求「依据必须能回到出处(哪个文件、哪个附件、哪个序号)」,
 * 三个地方各拼一遍的结果,必然是导出的那份和屏幕上的那份说的不一样。
 */
export function evidencePointerText(v: FirstRecognitionEvidence): string {
  return [
    v.sourceFile,
    v.attachment,
    v.listNo == null ? null : `序号 ${v.listNo}`,
    !isPageCapable(v.sourceFile) || v.page == null ? null : `第 ${v.page} 页`,
  ]
    .filter((part): part is string => !!part)
    .join(' · ')
}
