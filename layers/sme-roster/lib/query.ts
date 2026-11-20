import { MAX_PAGE_SIZE } from './query-limits'
import { readPublicPublishedNames,type OfficialPublishedFact } from './roster/official-published-presentation'
import { publishedNameText,type PublishedPresentation } from './roster/correspondence-view'
import { and,desc,eq,exists,inArray,isNull,like,or,sql,type SQL } from 'drizzle-orm'
import { compact,groupBy,minBy,orderBy } from 'es-toolkit'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { normalizeName } from './domain'
import { EVENTS,LIFECYCLE_FLAGS,LIFECYCLE_FLAG_ORDER,SOURCE_ORDER,TITLE_ORDER } from './labels'
import { isPageCapable } from './roster/evidence-page'
import {
judgeFirstRecognition,
matchesRecognitionQuery,
type FirstRecognitionStatus,
} from './roster/first-recognition'
import {
computeTitleLifecycle,
effectiveYear,
isQualifyingEvent,
type LifecycleEvent,
type TitleLifecycle,
} from './roster/lifecycle'

type Db = BetterSQLite3Database<typeof schema>

/** 事件类型,与 record_event.event_type 的取值一致。 */
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
function groupKey(enterpriseId: number, titleCode: string): string {
  return `${enterpriseId}/${titleCode}`
}

function buildWhere(db: Db, params: RecordFilterQuery): SQL | undefined {
  const conds: (SQL | undefined)[] = []
  if (params.title?.length) conds.push(inArray(schema.record.titleCode, params.title))
  if (params.source?.length) conds.push(inArray(schema.record.source, params.source as Source[]))
  if (params.district) conds.push(eq(schema.record.district, params.district))
  if (params.q) {
    // 名称按**归一化键**匹配(与归并口径一致),统代按归一化大写匹配。
    const name$ = normalizeName(params.q)
    const uscc$ = `%${params.q.trim().toUpperCase()}%`
    const hits: SQL[] = [like(schema.enterprise.usccNorm, uscc$)]
    if (name$) hits.push(like(schema.enterprise.nameNorm, `%${name$}%`))
    // 曾用名(RL-17 增量):只认 `confirmed` 的别名(契约 §1.2,`pending` 不参与搜索)。
    // 为什么加在这里:合并后的名录台账三个视图共用**同一个搜索框**,框上写着
    // 「企业名 / 曾用名 / 统一社会信用代码」。企业粒度那边一直认已确认曾用名,
    // 这一侧不认的话,同一个关键词在「按企业×称号」下会**静默返回 0 行** ——
    // 和「失败 ≠ 无记录」是同一类错误:筛选悄悄失效,用户只看到空结果。
    if (name$) {
      hits.push(
        exists(
          db
            .select({ hit: sql<number>`1` })
            .from(schema.enterpriseAlias)
            .where(
              and(
                eq(schema.enterpriseAlias.enterpriseId, schema.enterprise.id),
                eq(schema.enterpriseAlias.verificationStatus, 'confirmed'),
                like(schema.enterpriseAlias.nameNorm, `%${name$}%`),
              ),
            ),
        ),
      )
    }
    conds.push(or(...hits))
  }
  const flagConds = buildFlagConds(params.flags)
  if (flagConds) conds.push(flagConds)
  const eventCond = buildEventExists(db, params)
  if (eventCond) conds.push(eventCond)
  const filtered = compact(conds)
  return filtered.length ? and(...filtered) : undefined
}

/**
 * 质量标记筛选:逗号分隔的多个标记命中**任一**即匹配。
 * `uscc_missing` 直接看 `uscc_norm` 是否为空(与导入写入的 quality_flags 一致);
 * 其余标记按 `enterprise.quality_flags`(JSON 文本)包含判定。
 */
function buildFlagConds(flags: string | undefined): SQL | undefined {
  if (!flags) return undefined
  const list = flags
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (!list.length) return undefined
  const conds = list.map((f): SQL =>
    f === 'uscc_missing'
      ? isNull(schema.enterprise.usccNorm)
      : like(schema.enterprise.qualityFlags, `%${f}%`),
  )
  return conds.length === 1 ? conds[0] : or(...conds)
}

/**
 * 「组合下存在某类型 / 某年份事件」的相关 EXISTS 子查询。
 * 命中 record_event 中 record_id = record.id、且类型 ∈ 所选类型、年份 ∈ 所选年份的**同一条**事件。
 * 多值筛选在各自 `IN` 内命中任一即可。
 */
function buildEventExists(db: Db, params: RecordQuery): SQL | undefined {
  const types = params.eventType?.length ? params.eventType : undefined
  const years = params.year?.length ? params.year : undefined
  if (!types && !years) return undefined
  const sub: SQL[] = [eq(schema.recordEvent.recordId, schema.record.id)]
  if (types) sub.push(inArray(schema.recordEvent.eventType, types))
  if (years) sub.push(inArray(schema.recordEvent.year, years))
  return exists(
    db
      .select({ hit: sql<number>`1` })
      .from(schema.recordEvent)
      .where(and(...sub)),
  )
}

/**
 * 分页列出「企业 × 称号」组合,合并该组合下**全部来源、历史事件与出处**。
 *
 * `year` 先按事件年份选中组合；`dueYear`、`firstYear` 与 `firstStatus` 则在完整事件历史上筛选。
 * 派生值必须在分页前计算，否则 total 和分页结果都会错。
 */
export function listRecords(db: Db, params: RecordQuery): { rows: RecordRow[]; total: number } {
  const where = buildWhere(db, params)
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25))
  const titleRank = sql`case ${schema.record.titleCode} ${sql.join(
    TITLE_ORDER.map((code, i) => sql`when ${code} then ${i}`),
    sql` `,
  )} else ${TITLE_ORDER.length} end`
  const groupsQuery = () =>
    db
      .select({
        enterpriseId: schema.record.enterpriseId,
        titleCode: schema.record.titleCode,
      })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .groupBy(schema.record.enterpriseId, schema.record.titleCode)
      .orderBy(sql`min(${titleRank})`, sql`min(${schema.enterprise.name})`)

  if (params.dueYear != null || params.firstYear?.length || params.firstStatus?.length) {
    // 生命周期到期年、首次认定年与首次认定状态都是派生值，先对所有候选组合计算，再排序/分页。
    const candidates = groupsQuery().all()
    if (!candidates.length) return { rows: [], total: 0 }
    const derivedRows = buildRecordRows(db, candidates).filter((row) => {
      if (params.dueYear != null && row.lifecycle.dueYear !== params.dueYear) return false
      if (
        (params.firstYear?.length || params.firstStatus?.length) &&
        !matchesRecordRecognition(row, params)
      ) {
        return false
      }
      return true
    })
    return {
      rows: derivedRows.slice((page - 1) * pageSize, page * pageSize),
      total: derivedRows.length,
    }
  }

  const total =
    db
      .select({
        n: sql<number>`count(distinct ${schema.record.enterpriseId} || '/' || ${schema.record.titleCode})`,
      })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .get()?.n ?? 0

  const pageGroups = groupsQuery().limit(pageSize).offset((page - 1) * pageSize).all()
  return { rows: buildRecordRows(db, pageGroups), total }
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
function buildRecordRows(
  db: Db,
  pageGroups: { enterpriseId: number; titleCode: string }[],
): RecordRow[] {
  if (!pageGroups.length) return []
  const groupKeys = pageGroups.map((g) => groupKey(g.enterpriseId, g.titleCode))
  const keyExpr = sql`${schema.record.enterpriseId} || '/' || ${schema.record.titleCode}`
  const matched = db
    .select({
      recordId: schema.record.id,
      enterpriseId: schema.enterprise.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
      flags: schema.enterprise.qualityFlags,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(inArray(keyExpr, groupKeys))
    .orderBy(desc(schema.record.id))
    .all()

  const ids = matched.map((r) => r.recordId)
  const rawEvents = ids.length
    ? db
        .select({
          id: schema.recordEvent.id,
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          decidedYear: schema.recordEvent.decidedYear,
          reviewOutcome: schema.recordEvent.reviewOutcome,
          seq: schema.recordEvent.batchSeq,
          sortKey: schema.recordEvent.sortKey,
        })
        .from(schema.recordEvent)
        .where(inArray(schema.recordEvent.recordId, ids))
        .all()
    : []
  const eventIds = rawEvents.map((e) => e.id)
  const evidence = eventIds.length
    ? db
        .select({
          id: schema.recordEvidence.id,
          recordEventId: schema.recordEvidence.recordEventId,
          sourceFile: schema.recordEvidence.sourceFile,
          attachment: schema.recordEvidence.attachment,
          listNo: schema.recordEvidence.listNo,
          page: schema.recordEvidence.page,
        })
        .from(schema.recordEvidence)
        .where(inArray(schema.recordEvidence.recordEventId, eventIds))
        .all()
    : []

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
export function getEnterpriseDetail(db: Db, id: number): EnterpriseDetail | null {
  return db.transaction(() => enterpriseDetailSnapshot(db, id))
}

function enterpriseDetailSnapshot(db: Db, id: number): EnterpriseDetail | null {
  const ent = db
    .select({
      id: schema.enterprise.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.enterprise.district,
      qualityFlags: schema.enterprise.qualityFlags,
    })
    .from(schema.enterprise)
    .where(eq(schema.enterprise.id, id))
    .get()
  if (!ent) return null

  const anyRecord = db
    .select({ district: schema.record.district })
    .from(schema.record)
    .where(eq(schema.record.enterpriseId, id))
    .get()

  const records = db
    .select({
      id: schema.record.id,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
      district: schema.record.district,
    })
    .from(schema.record)
    .where(eq(schema.record.enterpriseId, id))
    .orderBy(schema.record.titleCode, schema.record.source)
    .all()

  const recordIds = records.map((r) => r.id)
  const events = recordIds.length
    ? db
        .select({
          id: schema.recordEvent.id,
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          seq: schema.recordEvent.batchSeq,
        })
        .from(schema.recordEvent)
        .where(sql`${schema.recordEvent.recordId} in ${recordIds}`)
        .orderBy(schema.recordEvent.sortKey)
        .all()
    : []
  const eventIds = events.map((e) => e.id)
  const evidence = eventIds.length
    ? db
        .select()
        .from(schema.recordEvidence)
        .where(sql`${schema.recordEvidence.recordEventId} in ${eventIds}`)
        .all()
    : []

  const evByEvent = groupBy(evidence, (v) => v.recordEventId)
  const evByRecord = groupBy(events, (e) => e.recordId)

  const publishedPresentation = readPublicPublishedNames(db, evidence.map(v => ({ evidenceId: v.id, eventId: v.recordEventId })))

  return {
    ...(publishedPresentation ? { publishedPresentation } : {}),
    id: ent.id,
    name: ent.name,
    uscc: ent.uscc,
    district: ent.district ?? anyRecord?.district ?? null,
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
export function allRecords(db: Db, params: RecordFilterQuery): ExportRow[] {
  return db.transaction(() => ledgerRecordsSnapshot(db, params))
}

function ledgerRecordsSnapshot(db: Db, params: RecordFilterQuery): ExportRow[] {
  const where = buildWhere(db, params)

  // 先按筛选挑出「企业 × 称号」组合,再取这些组合下的**全部**记录。
  // 筛选只决定导出哪些行,行内的来源与事件保持完整(与列表一致)。
  const groups = db
    .select({ enterpriseId: schema.record.enterpriseId, titleCode: schema.record.titleCode })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(where)
    .groupBy(schema.record.enterpriseId, schema.record.titleCode)
    .all()

  if (!groups.length) return []
  const keys = groups.map((g) => groupKey(g.enterpriseId, g.titleCode))
  const keyExpr = sql`${schema.record.enterpriseId} || '/' || ${schema.record.titleCode}`

  const matched = db
    .select({
      recordId: schema.record.id,
      enterpriseId: schema.record.enterpriseId,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(inArray(keyExpr, keys))
    .orderBy(schema.record.titleCode, schema.enterprise.name, schema.record.id)
    .all()

  const ids = matched.map((r) => r.recordId)
  const events = ids.length
    ? db
        .select({
          id: schema.recordEvent.id,
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          seq: schema.recordEvent.batchSeq,
          sortKey: schema.recordEvent.sortKey,
        })
        .from(schema.recordEvent)
        .where(inArray(schema.recordEvent.recordId, ids))
        .all()
    : []
  const eventIds = events.map((e) => e.id)
  const evidence = eventIds.length
    ? db
        .select()
        .from(schema.recordEvidence)
        .where(inArray(schema.recordEvidence.recordEventId, eventIds))
        .all()
    : []
  const evByRecord = groupBy(events, (e) => e.recordId)
  const evByEvent = groupBy(evidence, (v) => v.recordEventId)

  // 按「企业 × 称号」归并,保持 matched 的出现顺序(称号 → 企业名 → record.id)。
  const byKey = groupBy(matched, (r) => groupKey(r.enterpriseId, r.titleCode))

  const recordGroups = Object.values(byKey)
  const publishedByEvidence = new Map<number, OfficialPublishedFact>()
  for (let start = 0; start < recordGroups.length; start += 40) {
    const scopes = recordGroups.slice(start, start + 40).map(recs => recs.flatMap(r =>
      (evByRecord[r.recordId] ?? []).flatMap(e => (evByEvent[e.id] ?? []).map(v => ({ evidenceId: v.id, eventId: e.id }))),
    ))
    const batch = readPublicPublishedNames(db, scopes.flat())
    // Keep the existing per-group budget/error boundary if a batch cannot be projected.
    const results = batch.availability === 'available' ? [batch] : scopes.map(scope => readPublicPublishedNames(db, scope))
    for (const result of results) for (const fact of result.facts) publishedByEvidence.set(fact.evidenceId, fact)
  }

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
