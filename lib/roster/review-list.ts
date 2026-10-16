/**
 * **下一年度复核清单**(契约 §7.4,RL-09)—— 读模型,不碰 HTTP。
 *
 * 一行 = 一个 **企业 × 称号** 在目标年份到期的复核事项;两行清单:
 *
 *  - **到期清单**(`due`):锚点事件、批次、出处**证据齐全**,可以直接当工作单用;
 *  - **待确认清单**(`pending`):有资格声称(该称号下至少有一条认定/复核事件),
 *    但到期年算不出来、或算出来了却**不足以采信** —— 隔离出来交人确认,不混进工作单。
 *
 * ── 三年复核口径(契约 §6,`lib/roster/lifecycle.ts` 是唯一计算处)──────────
 * 锚点 = 最近一次「授予或延续有效资格」的事件(`max(decided_year ?? year)`,
 * 对 `award` 与 `reviewOutcome='passed'` 取最大);**到期 = 锚点 + 3**。
 * 复核通过刷新锚点但**不重置首次认定**;复核未通过**终止**当前有效资格。
 * 本文件**不重算**这些语义,只做「取数 + 分层(+ 判证据是否齐)」。
 *
 * ── 为什么「证据不全」必须隔离,而不是给个看着挺确定的年份 ────────────────
 * 票面 #9 的原话是「年份、批次或历史事件证据不全时进入待确认列表,**不靠文件名猜年份**」。
 * 所以清单里那些**缺批次 / 缺出处**的行不是"少一列",而是"这条工作项凭什么成立"没说完 ——
 * 拿文件名或目录结构把批次补上,就是明令禁止的猜填。宁可让它停在待确认里,由人补证据。
 *
 * ── 两处**解释**(都在汇报里列为待裁决点,不藏着)────────────────────────
 *
 * 1. **`decided_year` 缺失对 `award` 不算缺口**。契约 §6.4 说 `decided_year` 缺失时
 *    「退回 `year` 并标待核」;但 `decided_year` 这一列存在的理由(ADR §4.7)是
 *    **复核事件**的 `year` 记的是**被复核的原认定年份**,表达不出结论年份 ——
 *    而 `award` 事件的 `year` **按定义就是认定(结论)年份**。所以:
 *      - 锚点是 `award` 且缺 `decided_year` ⇒ 退回的年份**就是**那个年份,可信,进到期清单,
 *        并在行上如实标出 `anchorYearSource='event_year'`;
 *      - 锚点是 `reviewOutcome='passed'` 的复核且缺 `decided_year` ⇒ 退回的是**另一个年份**,
 *        算出来的到期年按构造就是错的 ⇒ `review_year_unconfirmed`,进待确认。
 *    若一律按字面把「缺 `decided_year`」全部隔离,真实库里 100% 的行都会掉进待确认
 *    (迁移 0007 之前的历史行 `decided_year` 恒为 NULL),清单就废了。
 *
 * 2. **待确认清单不带目标年份筛选**。「到期年算不出来」的行本来就不属于任何一年,
 *    若按目标年份筛,它们在任何一年里都不会出现 ⇒ **静默消失**,而那正是本票要防的事。
 *    所以待确认清单是「该称号下的证据确认队列」,与目标年份无关,每行仍带
 *    `tentativeDueYear` 供人判断它将来会落到哪一年。
 */
import { groupBy } from 'es-toolkit'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { TITLE_ORDER } from '../labels'
import { MAX_PAGE_SIZE } from '../query'
import {
  computeTitleLifecycle,
  effectiveYear,
  isQualifyingEvent,
  type LifecycleEvent,
} from './lifecycle'

type Db = BetterSQLite3Database<typeof schema>

/**
 * 清单的两种**分层取值**(`lib/labels.ts` 里的 `REVIEW_STATUSES` 是它的中文标签表,
 * 与 `PLATFORM_INTERFACE_VALUES` ↔ `PLATFORM_INTERFACES` 同一命名分工:
 * `_VALUES` 是取值数组,复数名词是标签映射 —— 两者同名会让人在 import 时选错)。
 */
export const REVIEW_STATUS_VALUES = ['due', 'pending'] as const
export type ReviewStatus = (typeof REVIEW_STATUS_VALUES)[number]

/**
 * 待确认的**可判别**原因(取值即判据,不是给人看的文案;文案在 `lib/labels.ts`)。
 *
 * 「可判别」是要紧的:如果只写一句「证据不全」,页面上就分不清
 * 「缺批次」和「复核结论未知」该怎么补 —— 前者翻公布文件,后者要回平台查申报记录。
 */
export const REVIEW_PENDING_REASON_VALUES = [
  /** 该称号下有认定/复核事件,但都没有可用年份 ⇒ 锚点无从计算。 */
  'no_anchor_year',
  /** 存在**结论未知**的复核(`reviewOutcome=null`),且其年份不早于锚点 ⇒ 资格是被延续还是被终止,未知。 */
  'review_outcome_unknown',
  /** 锚点是「复核通过」但缺结论年份 ⇒ 退回的 `year` 是被复核年份,算出的到期年不可信。 */
  'review_year_unconfirmed',
  /** 锚点事件缺批次序号 ⇒ 不拿文件名/目录推批次。 */
  'no_batch',
  /** 锚点事件没有任何出处记录 ⇒ 回不到来源。 */
  'no_evidence',
] as const
export type ReviewPendingReason = (typeof REVIEW_PENDING_REASON_VALUES)[number]

/** 出处一行:文件 / 附件 / 序号 / 页(与 `record_evidence` 同粒度)。 */
export interface ReviewEvidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

/** 锚点年份是从哪来的。`event_year` 表示结论年份没单独记,用的是事件所涉年份。 */
export type AnchorYearSource = 'decided_year' | 'event_year'

/** 两条清单共有的字段。 */
interface ReviewRowBase {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  /** 锚点事件 id(契约 §7.4 的 `basisEventId`);算不出锚点时为 `null`。 */
  basisEventId: number | null
  /** 锚点事件类型:`award` / `review`。 */
  basisEventType: string | null
  /** 锚点事件的**所涉**年份(复核事件里是**被复核的原认定年份**)。 */
  basisEventYear: number | null
  /** 锚点事件的**结论**年份;来源没给就是 `null`。 */
  basisDecidedYear: number | null
  /** 锚点年份的来源(见文件头的解释 ①)。 */
  anchorYearSource: AnchorYearSource | null
  /** 首次认定年份(复核**不重置**它);没有 `award` 时为 `null`。 */
  firstYear: number | null
  /** 首次认定所依据的事件 id。 */
  firstEventId: number | null
  /** 锚点所属记录的来源:`jxj` / `miit`。 */
  source: string | null
  /** 锚点事件的批次序号;来源没给就是 `null`。 */
  batchSeq: number | null
  /** 锚点事件的出处,逐条列出(不折叠)。 */
  evidence: ReviewEvidence[]
}

/** 到期清单的一行:证据齐全,可直接当工作单。 */
export interface ReviewRow extends ReviewRowBase {
  /** 锚点年份(契约 §7.4 的 `anchorYear`)。 */
  anchorYear: number
  /** 到期年份 = `anchorYear + 3`(契约 §7.4 的 `dueYear`)。 */
  dueYear: number
}

/** 待确认清单的一行:有资格声称,但到期年不可信 / 算不出。 */
export interface ReviewPendingRow extends ReviewRowBase {
  /** 为什么进不了到期清单(**可判别**,可同时多条,顺序固定)。 */
  reasons: ReviewPendingReason[]
  /** 已能算出的锚点年份(可能来自退回的所涉年份);算不出为 `null`。 */
  anchorYear: number | null
  /** 暂定到期年份 = `anchorYear + 3`,**仅供人工判断,未经确认**;算不出为 `null`。 */
  tentativeDueYear: number | null
}

/** 清单筛选。`year` 必填(到期清单的目标年份);`title` 多值,命中任一。 */
export interface RosterReviewFilter {
  year: number
  title?: string[]
}

/**
 * 计数:**先于分页、与筛选同口径**。
 *
 * ⚠️ 两者**互斥但不穷尽**,别把它俩加起来当全集(实测 `year=2027`:due 3087 + pending 3038 = 6125,
 * 而该称号下有资格声称的企业 × 称号是 9961):**证据齐全、但到期年在别处**的那些对,
 * 在这一年的清单里两边都不出现(2027 那次相差的 3836 对,锚点分别在 2023 / 2025 / 2026)。
 * 这不是漏洞 —— 「2027 年到期」这份清单本来就不该收别年的行;但**不许**据此宣称
 * 「页面上两个数字相加就是全部」。要看别年,换目标年份。
 */
export interface RosterReviewCounts {
  due: number
  pending: number
  /** 每个称号的两个桶(该称号没有行时不出现在这里)。 */
  titles: Record<string, { due: number; pending: number }>
}

export interface RosterReviewCandidates {
  due: ReviewRow[]
  pending: ReviewPendingRow[]
  counts: RosterReviewCounts
}

export interface RosterReviewsResult {
  year: number
  status: ReviewStatus
  /** `status='due'` 时为**分页后**的到期行;`status='pending'` 时为空数组。 */
  rows: ReviewRow[]
  /** `status='pending'` 时为**分页后**的待确认行;`status='due'` 时为空数组。 */
  pending: ReviewPendingRow[]
  counts: RosterReviewCounts
  page: number
  pageSize: number
}

const DEFAULT_PAGE_SIZE = 50

function titleRank(code: string): number {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? TITLE_ORDER.length : i
}

/** 排序:称号等级 → 企业名 → 企业 id。**确定性**排序,页面与导出逐行一致。 */
function compareRows(a: ReviewRowBase, b: ReviewRowBase): number {
  return (
    titleRank(a.titleCode) - titleRank(b.titleCode) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    a.enterpriseId - b.enterpriseId
  )
}

/** 该事件是否缺结论年份(⇒ 锚点只能退回所涉年份)。 */
function lacksDecidedYear(event: LifecycleEvent): boolean {
  return event.decidedYear == null
}

/** 一条事件在内存里的形态:生命周期字段 + 记账字段(批次 / 所属记录 / 出处)。 */
interface CandidateEvent extends LifecycleEvent {
  batchSeq: number | null
  source: string
  evidence: ReviewEvidence[]
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

/**
 * 一次读完再在内存里按 **(企业 × 称号)** 组织 —— 与 `enterprise-roster.ts` 同一取舍
 * (台账规模是几千企业 / 几万事件,一次读全表比按称号拼 join 更简单也更快)。
 */
export function collectReviewCandidates(db: Db, filter: RosterReviewFilter): RosterReviewCandidates {
  const titles = filter.title?.length ? new Set(filter.title) : null

  const enterprises = new Map(
    db
      .select({
        id: schema.enterprise.id,
        name: schema.enterprise.name,
        usccNorm: schema.enterprise.usccNorm,
        district: schema.enterprise.district,
      })
      .from(schema.enterprise)
      .all()
      .map((e) => [e.id, e] as const),
  )

  const records = db
    .select({
      id: schema.record.id,
      enterpriseId: schema.record.enterpriseId,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
      district: schema.record.district,
    })
    .from(schema.record)
    .all()

  const recordById = new Map(records.map((r) => [r.id, r] as const))

  const events = db
    .select({
      id: schema.recordEvent.id,
      recordId: schema.recordEvent.recordId,
      eventType: schema.recordEvent.eventType,
      year: schema.recordEvent.year,
      batchSeq: schema.recordEvent.batchSeq,
      decidedYear: schema.recordEvent.decidedYear,
      reviewOutcome: schema.recordEvent.reviewOutcome,
    })
    .from(schema.recordEvent)
    .all()

  const evidenceByEvent = groupBy(
    db
      .select({
        recordEventId: schema.recordEvidence.recordEventId,
        sourceFile: schema.recordEvidence.sourceFile,
        attachment: schema.recordEvidence.attachment,
        listNo: schema.recordEvidence.listNo,
        page: schema.recordEvidence.page,
      })
      .from(schema.recordEvidence)
      .all(),
    (v) => v.recordEventId,
  )

  // 事件按 **(企业 × 称号)** 归拢 —— 跨来源(公布 / 导出)合并,与
  // `enterprise-roster.ts` 的 `buildProfile` 同一口径(契约 §6.1)。
  const byPair = new Map<string, { enterpriseId: number; titleCode: string; events: CandidateEvent[] }>()
  for (const e of events) {
    const rec = recordById.get(e.recordId)
    if (!rec) continue
    if (titles && !titles.has(rec.titleCode)) continue
    const key = `${rec.enterpriseId}/${rec.titleCode}`
    let bucket = byPair.get(key)
    if (!bucket) {
      bucket = { enterpriseId: rec.enterpriseId, titleCode: rec.titleCode, events: [] }
      byPair.set(key, bucket)
    }
    bucket.events.push({
      id: e.id,
      eventType: e.eventType,
      year: e.year,
      decidedYear: e.decidedYear,
      reviewOutcome: e.reviewOutcome,
      batchSeq: e.batchSeq,
      source: rec.source,
      evidence: (evidenceByEvent[e.id] ?? [])
        .map((v) => ({
          sourceFile: v.sourceFile,
          attachment: v.attachment,
          listNo: v.listNo,
          page: v.page,
        }))
        .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || (a.listNo ?? 0) - (b.listNo ?? 0)),
    })
  }

  const due: ReviewRow[] = []
  const pending: ReviewPendingRow[] = []
  const counts: RosterReviewCounts = { due: 0, pending: 0, titles: {} }
  const bump = (titleCode: string, status: ReviewStatus) => {
    counts[status] += 1
    const bucket = (counts.titles[titleCode] ??= { due: 0, pending: 0 })
    bucket[status] += 1
  }

  for (const { enterpriseId, titleCode, events } of byPair.values()) {
    // 只有**有资格声称**的(企业 × 称号)才进清单。契约 §6.6 明说 `nurture`(入库培育)不构成
    // 称号有效期;`maintain`(维护)则由 §6.1 / §6.4 的口径排除 —— 首次认定只看 `award`、
    // 锚点只在 `award` ∪ `reviewOutcome='passed'` 上取(实现在 `lifecycle.ts`)。
    // 两类都没有的称号(实测小巨人目前只有维护事件)不是「待确认」,而是**不适用**:没有资格可复核。
    if (!events.some(isQualifyingEvent)) continue

    const enterprise = enterprises.get(enterpriseId)
    if (!enterprise) continue

    const lifecycle = computeTitleLifecycle(events)
    const eventById = new Map(events.map((e) => [e.id, e] as const))
    const anchor = lifecycle.anchorEventId != null ? eventById.get(lifecycle.anchorEventId) : undefined
    const anchorYear = lifecycle.anchorYear
    const byId = (id: number | null) => (id != null ? eventById.get(id) : undefined)
    const first = byId(lifecycle.firstRecognitionEventId)

    const base: ReviewRowBase = {
      enterpriseId,
      name: enterprise.name,
      uscc: enterprise.usccNorm,
      district: enterprise.district,
      titleCode,
      basisEventId: anchor?.id ?? null,
      basisEventType: anchor?.eventType ?? null,
      basisEventYear: anchor?.year ?? null,
      basisDecidedYear: anchor?.decidedYear ?? null,
      anchorYearSource: anchor == null ? null : lacksDecidedYear(anchor) ? 'event_year' : 'decided_year',
      firstYear: lifecycle.firstRecognitionYear,
      firstEventId: lifecycle.firstRecognitionEventId,
      source: anchor?.source ?? first?.source ?? null,
      batchSeq: anchor?.batchSeq ?? null,
      evidence: anchor?.evidence ?? [],
    }

    // 资格已被「未通过的复核」终止 ⇒ 两条清单都不进:它不是「待确认」,
    // 是**已经确定不在**当前有效资格的复核队列里(契约 §6.5、票面 #9)。
    if (lifecycle.state === 'terminated') continue

    const reasons: ReviewPendingReason[] = []
    if (anchor == null) {
      reasons.push('no_anchor_year')
    } else {
      // 锚点是复核、但缺结论年份 ⇒ 退回的 `year` 是被复核的原认定年份(≠ 结论年)。
      if (anchor.eventType === 'review' && lacksDecidedYear(anchor)) reasons.push('review_year_unconfirmed')
      if (anchor.batchSeq == null) reasons.push('no_batch')
      if (anchor.evidence.length === 0) reasons.push('no_evidence')
    }

    // 结论未知的复核(`reviewOutcome=null`)**不猜成通过**,也不猜成失败 ——
    // 若它不早于锚点,资格究竟被延续还是被终止就是未知的,只能交人确认。
    const danglingReviews = events.filter(
      (e) =>
        e.eventType === 'review' &&
        e.reviewOutcome == null &&
        effectiveYear(e) != null &&
        (anchorYear == null || (effectiveYear(e) as number) >= anchorYear),
    )
    if (danglingReviews.length) reasons.push('review_outcome_unknown')

    if (reasons.length === 0 && anchor != null && lifecycle.dueYear != null) {
      // 目标年份是**到期年**(不是事件年份):一批 2021 认定只在 2024 的清单里出现
      // (2024 = 2021 + 3),到了 2025 它已经**过了期**,不属于「2025 年需要复核的企业」。
      // 这里精确相等,不做「≤ 目标年」的逾期累积 —— 逾期是不是要接着办是另一个业务问题,
      // 不该由清单静默替用户决定。
      if (lifecycle.dueYear !== filter.year) continue
      due.push({ ...base, anchorYear: lifecycle.anchorYear as number, dueYear: lifecycle.dueYear })
      bump(titleCode, 'due')
    } else {
      pending.push({
        ...base,
        reasons,
        anchorYear,
        tentativeDueYear:
          anchorYear != null && lifecycle.state === 'active' ? anchorYear + 3 : null,
      })
      bump(titleCode, 'pending')
    }
  }

  due.sort(compareRows)
  pending.sort(compareRows)
  return { due, pending, counts }
}

function pageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page =
    Number.isFinite(input.page) && (input.page as number) >= 1 ? Math.floor(input.page as number) : 1
  const size =
    Number.isFinite(input.pageSize) && (input.pageSize as number) >= 1
      ? Math.floor(input.pageSize as number)
      : DEFAULT_PAGE_SIZE
  return { page, pageSize: Math.min(size, MAX_PAGE_SIZE) }
}

/**
 * 分页后的清单。`status` 决定 `rows` / `pending` 哪一边有内容 ——
 * 两边**都**在响应里(另一侧为空数组),读方不必按 status 猜字段名。
 *
 * `counts` 始终是**筛选后、分页前**的两个总数:页面上「N 项到期 · M 项待确认」
 * 必须与切页无关,否则用户会把「本页条数」当成「全量」。
 */
export function listRosterReviews(
  db: Db,
  filter: RosterReviewFilter & { status?: ReviewStatus; page?: number; pageSize?: number },
): RosterReviewsResult {
  const { due, pending, counts } = collectReviewCandidates(db, filter)
  const status: ReviewStatus = filter.status === 'pending' ? 'pending' : 'due'
  const { page, pageSize } = pageOf(filter)
  const slice = <T>(rows: T[]): T[] => rows.slice((page - 1) * pageSize, page * pageSize)

  return {
    year: filter.year,
    status,
    rows: status === 'due' ? slice(due) : [],
    pending: status === 'pending' ? slice(pending) : [],
    counts,
    page,
    pageSize,
  }
}

/** 该称号下全部候选(不分页)—— 导出用,保证「导出与本页同筛选、同口径」。 */
export function allRosterReviews(db: Db, filter: RosterReviewFilter): RosterReviewCandidates {
  return collectReviewCandidates(db, filter)
}
