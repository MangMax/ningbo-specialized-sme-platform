import { and, count, desc, eq, exists, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { groupBy, orderBy } from 'es-toolkit'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { isNingboDistrict, normalizeName } from './domain'
import { EVENTS, SOURCE_ORDER } from './labels'

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
  q?: string
  /**
   * 质量标记筛选(逗号分隔,命中任一即匹配)。
   * 目前支持 `uscc_missing`(无统代);其余标记按 `enterprise.quality_flags` 包含判定。
   */
  flags?: string
  page?: number
  pageSize?: number
}

/** 组合下的一条事件,保留其来源以便详情 / 导出区分。 */
export interface RecordEvent {
  type: string
  year: number | null
  seq: number | null
  source: string
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
  flags: string[]
}

const MAX_PAGE_SIZE = 200

/**
 * 把一组来源代号按展示顺序(经信局 → 工信部)去重排序,
 * 未知来源置后,保证列表与导出排序一致。
 */
function orderSources(sources: Iterable<string>): Source[] {
  const rest = new Set(sources)
  const ordered: string[] = []
  for (const s of SOURCE_ORDER) {
    if (rest.delete(s)) ordered.push(s)
  }
  for (const s of rest) ordered.push(s)
  return ordered as Source[]
}

/** 「企业 × 称号」组合键,列表与导出共用(用于分组页 / 定位组合)。 */
function groupKey(enterpriseId: number, titleCode: string): string {
  return `${enterpriseId}/${titleCode}`
}

function buildWhere(db: Db, params: RecordQuery): SQL | undefined {
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
    conds.push(or(...hits))
  }
  const flagConds = buildFlagConds(params.flags)
  if (flagConds) conds.push(flagConds)
  const eventCond = buildEventExists(db, params)
  if (eventCond) conds.push(eventCond)
  const filtered = conds.filter(Boolean) as SQL[]
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
 * 分页列出「企业 × 称号」组合,合并该组合下**全部匹配来源**的记录。
 *
 * 返回粒度为组合:一行含多个来源(`sources`)与该组合下全部事件(`events`,各带其来源)。
 * 分页与 total 均以**组合数**为准;先取本页组合,再取这些组合下匹配的记录。
 */
export function listRecords(db: Db, params: RecordQuery): { rows: RecordRow[]; total: number } {
  const where = buildWhere(db, params)
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25))

  // 总数 = 匹配的「企业 × 称号」组合数(而非 record 行数)。
  const total =
    db
      .select({
        n: sql<number>`count(distinct ${schema.record.enterpriseId} || '/' || ${schema.record.titleCode})`,
      })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .get()?.n ?? 0

  // 本页的组合(按组内最大 record.id 倒序,近似「最新在前」)。
  const pageGroups = db
    .select({
      enterpriseId: schema.record.enterpriseId,
      titleCode: schema.record.titleCode,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(where)
    .groupBy(schema.record.enterpriseId, schema.record.titleCode)
    .orderBy(desc(sql`max(${schema.record.id})`))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  if (!pageGroups.length) return { rows: [], total }

  const groupKeys = pageGroups.map((g) => groupKey(g.enterpriseId, g.titleCode))
  const keyExpr = sql`${schema.record.enterpriseId} || '/' || ${schema.record.titleCode}`

  // 仅取本页组合下**匹配筛选**的记录(组合内未命中的来源不计入)。
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
    .where(and(where, inArray(keyExpr, groupKeys)))
    .orderBy(desc(schema.record.id))
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

  const eventsByRecord = groupBy(events, (e) => e.recordId)
  const recordsByKey = groupBy(matched, (r) => groupKey(r.enterpriseId, r.titleCode))

  const rows: RecordRow[] = pageGroups.map((g) => {
    const key = groupKey(g.enterpriseId, g.titleCode)
    const recs = recordsByKey[key] ?? []
    const merged = recs
      .flatMap((r) =>
        (eventsByRecord[r.recordId] ?? []).map((e) => ({
          type: e.type,
          year: e.year,
          seq: e.seq,
          source: r.source as string,
          sortKey: e.sortKey,
          id: e.id,
        })),
      )
      .sort((a, b) => a.sortKey - b.sortKey || a.id - b.id)
      .map(({ type, year, seq, source }) => ({ type, year, seq, source }))
    // 区县取组内 record.id 最小且有值者(与导出同一规则,保证两侧一致)。
    const district = [...recs]
      .sort((a, b) => a.recordId - b.recordId)
      .find((r) => r.district)?.district ?? null
    return {
      enterpriseId: g.enterpriseId,
      name: recs[0]?.name ?? '',
      uscc: recs[0]?.uscc ?? null,
      district,
      titleCode: g.titleCode,
      sources: orderSources(recs.map((r) => r.source)),
      events: merged,
      flags: recs[0]?.flags ?? [],
    }
  })

  return { rows, total }
}

// ---------------------------------------------------------------------------
// 导入快照
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 企业详情
// ---------------------------------------------------------------------------

export interface DetailEvent {
  type: string
  year: number | null
  seq: number | null
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null }[]
}
export interface DetailRecord {
  titleCode: string
  source: string
  district: string | null
  events: DetailEvent[]
}
export interface EnterpriseDetail {
  id: number
  name: string
  uscc: string | null
  district: string | null
  qualityFlags: string[]
  records: DetailRecord[]
}

/** 某企业的全部记录、事件与出处。 */
export function getEnterpriseDetail(db: Db, id: number): EnterpriseDetail | null {
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

  return {
    id: ent.id,
    name: ent.name,
    uscc: ent.uscc,
    district: ent.district ?? anyRecord?.district ?? null,
    qualityFlags: ent.qualityFlags ?? [],
    records: records.map((r) => ({
      titleCode: r.titleCode,
      source: r.source,
      district: r.district,
      events: (evByRecord[r.id] ?? []).map((e) => ({
        type: e.type,
        year: e.year,
        seq: e.seq,
        evidence: (evByEvent[e.id] ?? []).map((v) => ({
          sourceFile: v.sourceFile,
          attachment: v.attachment,
          listNo: v.listNo,
        })),
      })),
    })),
  }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export interface Stats {
  totalRecords: number
  totalEnterprises: number
  byTitle: { key: string; n: number }[]
  bySource: { key: string; n: number }[]
  byEvent: { key: string; n: number }[]
  byDistrict: { key: string; n: number }[]
  byYear: { key: string; n: number }[]
}

/** 统计过滤条件(与 `/api/stats` 的 query 参数一致)。 */
export interface StatsFilter {
  title?: string
  district?: string
  source?: string
}

/**
 * 计数聚合。
 *
 * **全部计数以「记录」为单位**,与 `listRecords` 的筛选语义一致:
 * - `byTitle` / `bySource` / `byDistrict`:record 表本身即「企业 × 称号 × 来源」,
 *   按列分组计数即「记录数」。
 * - `byEvent` / `byYear`:按**有该事件类型 / 年份的记录数**(distinct record_id),
 *   等于 `listRecords({ eventType })` / `listRecords({ year })` 的 total —— 不再是事件条数。
 */
export function getStats(db: Db, filter: StatsFilter = {}): Stats {
  const conds: SQL[] = []
  if (filter.title) conds.push(eq(schema.record.titleCode, filter.title))
  if (filter.source) conds.push(eq(schema.record.source, filter.source as 'jxj' | 'miit'))
  if (filter.district) conds.push(eq(schema.record.district, filter.district))
  const where = conds.length ? and(...conds) : undefined

  const totalRecords = db.select({ n: count() }).from(schema.record).where(where).get()?.n ?? 0

  const totalEnterprises =
    db
      .select({ n: sql<number>`count(distinct ${schema.record.enterpriseId})` })
      .from(schema.record)
      .where(where)
      .get()?.n ?? 0

  /** 记录维度:按 record 的某列分组计数(称号 / 来源 / 区县)。 */
  const byRecordColumn = (column: AnySQLiteColumn) => {
    const rows = db
      .select({ key: column, n: count() })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .groupBy(column)
      .all() as { key: unknown; n: number }[]
    return rows.map((r) => ({ key: String(r.key ?? '—'), n: r.n }))
  }

  /** 记录维度:按某个事件列分组,数**有该事件的记录数**(distinct record_id)。 */
  const byEventColumn = (column: AnySQLiteColumn) => {
    const rows = db
      .select({ key: column, n: sql<number>`count(distinct ${schema.recordEvent.recordId})` })
      .from(schema.recordEvent)
      .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
      .where(where)
      .groupBy(column)
      .all() as { key: unknown; n: number }[]
    return rows.map((r) => ({ key: String(r.key ?? '—'), n: r.n }))
  }

  const byYear = byEventColumn(schema.recordEvent.year).sort((a, b) => a.key.localeCompare(b.key))

  return {
    totalRecords,
    totalEnterprises,
    byTitle: byRecordColumn(schema.record.titleCode),
    bySource: byRecordColumn(schema.record.source),
    byEvent: byEventColumn(schema.recordEvent.eventType),
    byDistrict: orderBy(byRecordColumn(schema.record.district), [(r) => r.n], ['desc']).slice(0, 20),
    byYear,
  }
}

// ---------------------------------------------------------------------------
// 数据质量
// ---------------------------------------------------------------------------

export interface QualityGroup {
  kind: string
  label: string
  n: number
  samples: { enterpriseId: number; name: string; uscc: string | null; district: string | null }[]
}

/**
 * 可由公布文件/工信部名单直接推出的质量项。
 * - `uscc_missing`:无统代(按名称归并)。
 * - `name_ambiguous`:重名 —— 同名(归一化后)对应多个企业,或同名下出现多个不同统代。
 *
 * 非宁波、注销等需外部富化数据,不在本期(见 SPEC 用户故事 11 与 ADR)。
 */
export function getQuality(db: Db): QualityGroup[] {
  const usccMissing = db
    .select({ enterpriseId: schema.enterprise.id, name: schema.enterprise.name, uscc: schema.enterprise.usccNorm, district: schema.enterprise.district })
    .from(schema.enterprise)
    .where(isNull(schema.enterprise.usccNorm))
    .all()

  // 重名:同名(归一化后)对应多个企业,或同名下出现多个不同统代。
  const dupNames = db
    .select({ nameNorm: schema.enterprise.nameNorm })
    .from(schema.enterprise)
    .groupBy(schema.enterprise.nameNorm)
    .having(sql`count(*) > 1 or count(distinct ${schema.enterprise.usccNorm}) > 1`)

  const ambiguous = db
    .select({ enterpriseId: schema.enterprise.id, name: schema.enterprise.name, uscc: schema.enterprise.usccNorm, district: schema.enterprise.district })
    .from(schema.enterprise)
    .where(inArray(schema.enterprise.nameNorm, dupNames))
    .orderBy(schema.enterprise.nameNorm)
    .all()

  // 漂移:属地不在宁波区县/功能区之列(可能是外市注册,或来源里的写法异常)。
  const offCity = db
    .select({ enterpriseId: schema.enterprise.id, name: schema.enterprise.name, uscc: schema.enterprise.usccNorm, district: schema.enterprise.district })
    .from(schema.enterprise)
    .where(and(sql`${schema.enterprise.district} is not null`, sql`${schema.enterprise.district} <> ''`))
    .all()
    .filter((e) => !isNingboDistrict(e.district ?? ''))

  return [
    {
      kind: 'uscc_missing',
      label: '无统一社会信用代码(按名称归并)',
      n: usccMissing.length,
      samples: usccMissing.slice(0, 50),
    },
    {
      kind: 'name_ambiguous',
      label: '重名(同名对应多个主体)',
      n: ambiguous.length,
      samples: ambiguous.slice(0, 50),
    },
    {
      kind: 'district_off_city',
      label: '属地不在宁波(可能是外市注册或写法异常)',
      n: offCity.length,
      samples: offCity.slice(0, 50),
    },
  ]
}

// ---------------------------------------------------------------------------
// 导出(不分页)
// ---------------------------------------------------------------------------

/** 导出行:粒度与列表一致,一行 = 企业 × 称号。 */
export interface ExportRow {
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  /** 该组合下的全部来源(按经信局 → 工信部排序)。 */
  sources: string[]
  events: string
  /** 出处:该组合各事件的「文件 / 附件 / 序号」汇总为一行文本。 */
  evidence: string
}

/** 单条证据渲染为 `文件 / 附件 / 序号N`。 */
function formatEvidence(v: {
  sourceFile: string
  attachment: string | null
  listNo: number | null
}): string {
  const parts = [v.sourceFile]
  if (v.attachment) parts.push(v.attachment)
  if (v.listNo != null) parts.push(`序号${v.listNo}`)
  return parts.join(' / ')
}

/**
 * 取全部匹配记录(用于导出),按「企业 × 称号」归并:
 * 事件与出处合并该组合下全部事件,来源列出全部来源。
 */
export function allRecords(db: Db, params: RecordQuery): ExportRow[] {
  const where = buildWhere(db, params)
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
    .where(where)
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
  const byKey = new Map<string, typeof matched>()
  for (const r of matched) {
    const key = groupKey(r.enterpriseId, r.titleCode)
    const arr = byKey.get(key)
    if (arr) arr.push(r)
    else byKey.set(key, [r])
  }

  return [...byKey.values()].map((recs) => {
    const sorted = [...recs].sort((a, b) => a.recordId - b.recordId)
    const head = sorted[0]!
    const district = sorted.find((r) => r.district)?.district ?? null
    // 该组合下全部事件(保留每条事件所属来源),按 sortKey 排序。
    const evRows = recs
      .flatMap((r) =>
        (evByRecord[r.recordId] ?? []).map((e) => ({
          type: e.type,
          year: e.year,
          seq: e.seq,
          sortKey: e.sortKey,
          id: e.id,
          recordId: r.recordId,
        })),
      )
      .sort((a, b) => a.sortKey - b.sortKey || a.id - b.id)
    const evidenceText = evRows
      .flatMap((e) => (evByEvent[e.id] ?? []).map(formatEvidence))
      .join('; ')
    return {
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
