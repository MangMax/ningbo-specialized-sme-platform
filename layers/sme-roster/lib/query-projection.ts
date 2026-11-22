import type { OfficialPublishedFact, OfficialPublishedScope } from './roster/official-published-presentation'
import { publishedNameText, type PublishedPresentation } from './roster/correspondence-view'
import { compact, groupBy, minBy, orderBy } from 'es-toolkit'
import { EVENTS, LIFECYCLE_FLAGS, LIFECYCLE_FLAG_ORDER, SOURCE_ORDER, TITLE_ORDER } from './labels'
import { isPageCapable } from './roster/evidence-page'
import { judgeFirstRecognition, matchesRecognitionQuery, type FirstRecognitionStatus } from './roster/first-recognition'
import { computeTitleLifecycle, effectiveYear, isQualifyingEvent, type LifecycleEvent, type TitleLifecycle } from './roster/lifecycle'

export type EventType = 'award' | 'review' | 'maintain' | 'nurture'

/** 来源代号。 */
export type Source = 'jxj' | 'miit'

/**
 * 台账查询条件。四个筛选(称号 / 来源 / 事件类型 / 年份)均为**多值**:
 * 同一筛选内命中任一即匹配(SQL `IN`);不同筛选之间取交集。
 */
export interface RecordQuery {
  title?: string[]
  source?: string[]
  district?: string
  /** 命中「该组合下存在此类型的事件」。 */
  eventType?: EventType[]
  /** 命中「该组合下存在此年份的事件」。 */
  year?: number[]
  /** 命中生命周期计算出的最早正式认定年份；与事件年份 `year` 分开。 */
  firstYear?: number[]
  /** 命中共享首次认定判定出的状态。 */
  firstStatus?: FirstRecognitionStatus[]
  /** 精确匹配生命周期计算出的到期年份；与事件年份 `year` 分开。 */
  dueYear?: number
  q?: string
  /**
   * 质量标记筛选(逗号分隔,命中任一即匹配)。
   * 目前支持 `uscc_missing`(无统代);其余标记按 `enterprise.quality_flags` 包含判定。
   */
  flags?: string
  page?: number
  pageSize?: number
}

/** Filters accepted by the existing Excel export; it has no lifecycle due-year mode. */
export type RecordFilterQuery = Omit<
  RecordQuery,
  'dueYear' | 'firstYear' | 'firstStatus' | 'page' | 'pageSize'
>

export type LifecycleFlag =
  | 'decided_year_missing'
  | 'review_outcome_unknown'
  | 'no_batch'
  | 'no_evidence'
  | 'no_anchor_year'

/** 组合下的一条事件,带上生命周期字段与可回溯出处。 */
export interface RecordEvent {
  id: number
  recordId: number
  type: string
  year: number | null
  decidedYear: number | null
  reviewOutcome: string | null
  seq: number | null
  batchSeq: number | null
  source: Source
  evidence: {
    sourceFile: string
    attachment: string | null
    listNo: number | null
    page: number | null
  }[]
}

/** 通用记录查询中复用的称号生命周期计算与待核原因。 */
export interface RecordLifecycle extends TitleLifecycle {
  status: 'active' | 'needs_review' | 'terminated' | 'undatable' | 'not_applicable'
  /** 标记只说明证据缺口，不会把企业×称号行排除出未筛选结果。 */
  flags: { code: LifecycleFlag; reason: string }[]
}

/** 一行 = 企业 × 称号,合并该组合下**全部来源**的记录。 */
export interface RecordRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  sources: Source[]
  events: RecordEvent[]
  lifecycle: RecordLifecycle
  flags: string[]
}

export type LedgerGroup = { enterpriseId: number; titleCode: string }
export type LedgerSource = LedgerGroup & {
  recordId: number; name: string; uscc: string | null; district: string | null;
  source: string; flags: string[] | null
}
export type LedgerEvent = Pick<RecordEvent, 'id' | 'recordId' | 'type' | 'year' | 'decidedYear' | 'reviewOutcome' | 'seq'> & { sortKey: number }
export type LedgerEvidence = RecordEvent['evidence'][number] & { recordEventId: number }

export { MAX_PAGE_SIZE } from './query-limits'

/**
 * 把一组来源代号按展示顺序(经信局 → 工信部)去重排序,
 * 未知来源置后,保证列表与导出排序一致。
 */
function orderSources(sources: Iterable<string>): Source[] {
  const seen = new Set(sources)
  return [
    ...SOURCE_ORDER.filter((s) => seen.has(s)),
    ...[...seen].filter((s) => !SOURCE_ORDER.includes(s)),
  ] as Source[]
}

/** 「企业 × 称号」组合键,列表与导出共用(用于分组页 / 定位组合)。 */
export function groupKey(enterpriseId: number, titleCode: string): string {
  return `${enterpriseId}/${titleCode}`
}

export function matchesLedgerDerivedFilters(row: RecordRow, params: RecordQuery) {
  return (params.dueYear == null || row.lifecycle.dueYear === params.dueYear) &&
    (!(params.firstYear?.length || params.firstStatus?.length) || matchesRecordRecognition(row, params))
}

/** 首次年份与状态都使用 RL-08 已有的共享判定和筛选语义。 */
function matchesRecordRecognition(row: RecordRow, params: RecordQuery): boolean {
  const recognition = judgeFirstRecognition({
    titleCode: row.titleCode,
    lifecycle: row.lifecycle,
    events: row.events.map((event) => ({
      id: event.id,
      eventType: event.type,
      year: event.year,
      decidedYear: event.decidedYear,
      reviewOutcome: event.reviewOutcome,
      source: event.source,
    })),
    evidenceByEvent: new Map(row.events.map((event) => [event.id, event.evidence])),
  })
  return (
    recognition != null &&
    matchesRecognitionQuery(recognition, {
      firstYear: params.firstYear,
      firstStatus: params.firstStatus,
    })
  )
}

/** 读取分组下全部来源/事件/出处并投影同一生命周期结果。 */
export function projectLedgerRows(pageGroups: LedgerGroup[], matched: LedgerSource[], rawEvents: LedgerEvent[], evidence: LedgerEvidence[]): RecordRow[] {
  const evidenceByEvent = groupBy(evidence, (row) => row.recordEventId)
  const eventsByRecord = groupBy(rawEvents, (e) => e.recordId)
  const recordsByKey = groupBy(matched, (r) => groupKey(r.enterpriseId, r.titleCode))

  return pageGroups.map((g) => {
    const recs = recordsByKey[groupKey(g.enterpriseId, g.titleCode)] ?? []
    const merged: RecordEvent[] = orderBy(
      recs.flatMap((r) =>
        (eventsByRecord[r.recordId] ?? []).map((e) => ({ ...e, source: r.source as Source })),
      ),
      [(e) => e.sortKey, (e) => e.id],
      ['asc', 'asc'],
    ).map((e) => ({
      id: e.id,
      recordId: e.recordId,
      type: e.type,
      year: e.year,
      decidedYear: e.decidedYear,
      reviewOutcome: e.reviewOutcome,
      seq: e.seq,
      batchSeq: e.seq,
      source: e.source,
      evidence: (evidenceByEvent[e.id] ?? []).map(({ sourceFile, attachment, listNo, page }) => ({
        sourceFile,
        attachment,
        listNo,
        page: isPageCapable(sourceFile) ? page : null,
      })),
    }))
    const lifecycleEvents: LifecycleEvent[] = merged.map((e) => ({
      id: e.id,
      eventType: e.type,
      batchSeq: e.batchSeq,
      year: e.year,
      decidedYear: e.decidedYear,
      reviewOutcome: e.reviewOutcome,
    }))
    const calculated = computeTitleLifecycle(lifecycleEvents)
    const anchor = merged.find((e) => e.id === calculated.anchorEventId)
    const hasQualifyingEvent = lifecycleEvents.some(isQualifyingEvent)
    const flags = new Set<LifecycleFlag>()
    if (hasQualifyingEvent && (calculated.anchorEventId == null || calculated.anchorYear == null)) {
      flags.add('no_anchor_year')
    }
    if (anchor?.decidedYear == null && anchor != null) flags.add('decided_year_missing')
    const anchorYear = calculated.anchorYear
    if (
      merged.some((e) => {
        if (e.type !== 'review' || e.reviewOutcome != null) return false
        const eventYear = effectiveYear({
          id: e.id,
          eventType: e.type,
          year: e.year,
          decidedYear: e.decidedYear,
          reviewOutcome: e.reviewOutcome,
        })
        return eventYear == null || anchorYear == null || eventYear >= anchorYear
      })
    ) {
      flags.add('review_outcome_unknown')
    }
    if (anchor?.batchSeq == null && anchor != null) flags.add('no_batch')
    if (anchor && anchor.evidence.length === 0) flags.add('no_evidence')
    const status: RecordLifecycle['status'] = !hasQualifyingEvent
      ? 'not_applicable'
      : calculated.state === 'terminated'
        ? 'terminated'
        : calculated.needsReview
          ? 'needs_review'
          : calculated.anchorEventId == null || calculated.dueYear == null
            ? 'undatable'
            : flags.size > 0
              ? 'needs_review'
              : 'active'

    const district = minBy(recs.filter((r) => r.district), (r) => r.recordId)?.district ?? null
    return {
      enterpriseId: g.enterpriseId,
      name: recs[0]?.name ?? '',
      uscc: recs[0]?.uscc ?? null,
      district,
      titleCode: g.titleCode,
      sources: orderSources(recs.map((r) => r.source)),
      events: merged,
      lifecycle: {
        ...calculated,
        status,
        flags: LIFECYCLE_FLAG_ORDER.filter((code) => flags.has(code as LifecycleFlag)).map((code) => ({
          code: code as LifecycleFlag,
          reason: LIFECYCLE_FLAGS[code] ?? code,
        })),
      },
      flags: recs[0]?.flags ?? [],
    }
  })
}

// ---------------------------------------------------------------------------
// 导入快照
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 企业详情
// ---------------------------------------------------------------------------

export interface DetailEvent {
  id: number
  recordId: number
  type: string
  year: number | null
  seq: number | null
  /**
   * 出处(文件 / 附件 / 序号 / **页码**)。
   *
   * `page` 是 **PDF 实际页序**(`record_evidence.page`,1 起),给不出就是 `null`
   * (RL-10)。它与 `listNo`(名单里的**序号**)是两回事 —— 把序号当页码会跳到错的页上。
   * 界面据 `evidencePageState()` 把它分成三种说法:有页码 / **页码待核**(PDF 但还没定)/
   * 本来就没有页(Word、Excel)。
   */
  evidence: {
    id: number
    sourceFile: string
    attachment: string | null
    listNo: number | null
    page: number | null
  }[]
}
export interface DetailRecord {
  id: number
  titleCode: string
  source: string
  district: string | null
  events: DetailEvent[]
}
export interface EnterpriseDetail {
  publishedPresentation?: PublishedPresentation
  id: number
  name: string
  uscc: string | null
  district: string | null
  qualityFlags: string[]
  records: DetailRecord[]
}

/** 某企业的全部记录、事件与出处。 */
export function projectEnterpriseDetail(
  ent: Pick<EnterpriseDetail, 'id' | 'name' | 'uscc' | 'district'> & { qualityFlags: string[] | null },
  recordDistrict: string | null,
  records: Omit<DetailRecord, 'events'>[],
  events: Omit<DetailEvent, 'evidence'>[],
  evidence: (DetailEvent['evidence'][number] & { recordEventId: number })[],
  publishedPresentation: PublishedPresentation,
): EnterpriseDetail {
  const evByEvent = groupBy(evidence, (v) => v.recordEventId)
  const evByRecord = groupBy(events, (e) => e.recordId)
  return {
    publishedPresentation,
    id: ent.id,
    name: ent.name,
    uscc: ent.uscc,
    district: ent.district ?? recordDistrict,
    qualityFlags: ent.qualityFlags ?? [],
    records: records.map((r) => ({
      id: r.id,
      titleCode: r.titleCode,
      source: r.source,
      district: r.district,
      events: (evByRecord[r.id] ?? []).map((e) => ({
        id: e.id,
        recordId: r.id,
        type: e.type,
        year: e.year,
        seq: e.seq,
        evidence: (evByEvent[e.id] ?? []).map((v) => ({
          id: v.id,
          sourceFile: v.sourceFile,
          attachment: v.attachment,
          listNo: v.listNo,
          page: isPageCapable(v.sourceFile) ? v.page : null,
        })),
      })),
    })),
  }
}

// ---------------------------------------------------------------------------
// 导出(不分页)
// ---------------------------------------------------------------------------

/**
 * 导出行:粒度与列表一致,一行 = 企业 × 称号。
 *
 * `enterpriseId` 是 RL-17 补的:导出的口径行要写「这些行属于多少家**企业**」,
 * 而「行数」与「企业数」在合并台账里是两个口径。用 id 去重,不用名字 ——
 * 重名企业(实测存在)按名去重会把两家算成一家。
 */
export interface ExportRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  /** 该组合下的全部来源(按经信局 → 工信部排序)。 */
  sources: string[]
  events: string
  /** 出处:该组合各事件的「文件 / 附件 / 序号 / 页码」汇总为一行文本。 */
  evidence: string
}

/**
 * 单条证据渲染为 `文件 / 附件 / 序号N / 第N页`。
 *
 * 页码只对有稳定页序的 PDF 且**真的定下来**时才写。没有页码**不写任何占位** ——
 * 导出文本里的一句「页码待核」既没有可复核的值、又会让「这一列到底有没有数据」
 * 变得读不出来;那是界面上的说法(见 `evidencePageState`),不是导出文本的。
 */
function formatEvidence(v: {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}): string {
  return compact([
    v.sourceFile,
    v.attachment,
    v.listNo != null ? `序号${v.listNo}` : null,
    isPageCapable(v.sourceFile) && v.page != null ? `第${v.page}页` : null,
  ]).join(' / ')
}

/**
 * 取全部匹配记录(用于导出),按「企业 × 称号」归并:
 * 事件与出处合并该组合下全部事件,来源列出全部来源。
 */
export type LedgerExportSource = Omit<LedgerSource, 'flags'>
export type LedgerExportEvent = Pick<LedgerEvent, 'id' | 'recordId' | 'type' | 'year' | 'seq' | 'sortKey'>
export type LedgerExportEvidence = LedgerEvidence & { id: number }

export function prepareLedgerExportProjection(matched: LedgerExportSource[], events: LedgerExportEvent[], evidence: LedgerExportEvidence[]) {
  const evByRecord = groupBy(events, (e) => e.recordId)
  const evByEvent = groupBy(evidence, (v) => v.recordEventId)

  // 按「企业 × 称号」归并,保持 matched 的出现顺序(称号 → 企业名 → record.id)。
  const byKey = groupBy(matched, (r) => groupKey(r.enterpriseId, r.titleCode))

  const recordGroups = Object.values(byKey)
  const scopes: OfficialPublishedScope[][] = recordGroups.map(recs => recs.flatMap(r =>
    (evByRecord[r.recordId] ?? []).flatMap(e => (evByEvent[e.id] ?? []).map(v => ({ evidenceId: v.id, eventId: e.id }))),
  ))
  function rows(publishedByEvidence: ReadonlyMap<number, OfficialPublishedFact>): ExportRow[] {
    return recordGroups.map((recs) => {
      const head = minBy(recs, (r) => r.recordId)!
      // 组内 enterpriseId 恒定(分组键就是它),取 head 的即可。
      const enterpriseId = head.enterpriseId
      // 区县取组内 record.id 最小且有值者(与列表同一规则)。
      const district = minBy(recs.filter((r) => r.district), (r) => r.recordId)?.district ?? null
      // 该组合下全部事件(保留每条事件所属来源),按 sortKey 排序。
      const evRows = orderBy(
        recs.flatMap((r) =>
          (evByRecord[r.recordId] ?? []).map((e) => ({
            type: e.type,
            year: e.year,
            seq: e.seq,
            sortKey: e.sortKey,
            id: e.id,
            recordId: r.recordId,
          })),
        ),
        [(e) => e.sortKey, (e) => e.id],
        ['asc', 'asc'],
      )
      const selectedEvidence = evRows.flatMap(e => evByEvent[e.id] ?? [])
      const evidenceText = selectedEvidence.map(v => {
        const locator = formatEvidence(v)
        const fact = publishedByEvidence.get(v.id)
        return locator + ' / ' + (fact ? publishedNameText(fact) : '公布名称暂不可用')
      }).join('; ')
      return {
        enterpriseId,
        name: head.name,
        uscc: head.uscc,
        district,
        titleCode: head.titleCode,
        sources: orderSources(recs.map((r) => r.source)),
        events: evRows
          .map((e) => `${EVENTS[e.type] ?? e.type} ${e.year ?? ''}${e.seq ? '-' + e.seq : ''}`.trim())
          .join('; '),
        evidence: evidenceText,
      }
    })
  }
  return { scopes, rows }
}
