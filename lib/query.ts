import { and, count, desc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { groupBy, orderBy } from 'es-toolkit'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

type Db = BetterSQLite3Database<typeof schema>

export interface RecordQuery {
  title?: string
  source?: string
  district?: string
  eventType?: string
  q?: string
  /** 导入快照筛选(import_batch.id)。见票 11。 */
  batchId?: number
  page?: number
  pageSize?: number
}

export interface RecordRow {
  recordId: number
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  source: string
  events: { type: string; year: number | null; seq: number | null }[]
}

const MAX_PAGE_SIZE = 200

function buildWhere(params: RecordQuery): SQL | undefined {
  const conds: (SQL | undefined)[] = []
  if (params.title) conds.push(eq(schema.record.titleCode, params.title))
  if (params.source) conds.push(eq(schema.record.source, params.source as 'jxj' | 'miit'))
  if (params.district) conds.push(eq(schema.record.district, params.district))
  if (params.batchId) conds.push(eq(schema.record.importBatchId, params.batchId))
  if (params.q) {
    const like$ = `%${params.q.trim()}%`
    conds.push(or(like(schema.enterprise.name, like$), like(schema.enterprise.usccNorm, like$)))
  }
  const filtered = conds.filter(Boolean) as SQL[]
  return filtered.length ? and(...filtered) : undefined
}

/** 分页列出记录,附其事件摘要。 */
export function listRecords(db: Db, params: RecordQuery): { rows: RecordRow[]; total: number } {
  const where = buildWhere(params)
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? 25))

  const total =
    db
      .select({ n: count() })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .get()?.n ?? 0

  const base = db
    .select({
      recordId: schema.record.id,
      enterpriseId: schema.enterprise.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(where)
    .orderBy(desc(schema.record.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  const ids = base.map((r) => r.recordId)
  const events = ids.length
    ? db
        .select({
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          seq: schema.recordEvent.batchSeq,
        })
        .from(schema.recordEvent)
        .where(sql`${schema.recordEvent.recordId} in ${ids}`)
        .orderBy(schema.recordEvent.sortKey)
        .all()
    : []

  const byRecord = groupBy(events, (e) => e.recordId)

  const rows: RecordRow[] = base.map((r) => ({
    ...r,
    events: (byRecord[r.recordId] ?? []).map((e) => ({ type: e.type, year: e.year, seq: e.seq })),
  }))
  return { rows, total }
}

// ---------------------------------------------------------------------------
// 导入快照
// ---------------------------------------------------------------------------

export interface BatchInfo {
  id: number
  label: string
  sourceRoot: string
  importedAt: string
  note: string | null
  /** 归属该快照的记录数(record.import_batch_id)。 */
  recordCount: number
}

/** 全部导入快照,最新在前(默认用于台账页「当前快照」)。 */
export function listBatches(db: Db): BatchInfo[] {
  const counts = db
    .select({ batchId: schema.record.importBatchId, n: count() })
    .from(schema.record)
    .groupBy(schema.record.importBatchId)
    .all()
  const byBatch = new Map(counts.map((c) => [c.batchId, c.n]))
  return db
    .select()
    .from(schema.importBatch)
    .orderBy(desc(schema.importBatch.id))
    .all()
    .map((b) => ({
      id: b.id,
      label: b.label,
      sourceRoot: b.sourceRoot,
      importedAt: b.importedAt,
      note: b.note,
      recordCount: byBatch.get(b.id) ?? 0,
    }))
}

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

export function getStats(db: Db): Stats {
  const scalars = (column: AnySQLiteColumn) => {
    const rows = db
      .select({ key: column, n: count() })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .groupBy(column)
      .all() as { key: unknown; n: number }[]
    return rows.map((r) => ({ key: String(r.key ?? '—'), n: r.n }))
  }

  const totalRecords = db.select({ n: count() }).from(schema.record).get()?.n ?? 0
  const totalEnterprises = db.select({ n: count() }).from(schema.enterprise).get()?.n ?? 0

  const byYear = db
    .select({ key: schema.recordEvent.year, n: count() })
    .from(schema.recordEvent)
    .groupBy(schema.recordEvent.year)
    .all()
    .map((r) => ({ key: String(r.key ?? '—'), n: r.n }))
    .sort((a, b) => a.key.localeCompare(b.key))

  return {
    totalRecords,
    totalEnterprises,
    byTitle: scalars(schema.record.titleCode),
    bySource: scalars(schema.record.source),
    byEvent: db
      .select({ key: schema.recordEvent.eventType, n: count() })
      .from(schema.recordEvent)
      .groupBy(schema.recordEvent.eventType)
      .all()
      .map((r) => ({ key: r.key, n: r.n })),
    byDistrict: orderBy(scalars(schema.record.district), [(r) => r.n], ['desc']).slice(0, 20),
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

/** 可由公布文件/工信部名单直接推出的质量项。非宁波、注销等需外部富化数据,不在本期。 */
export function getQuality(db: Db): QualityGroup[] {
  const usccMissing = db
    .select({ enterpriseId: schema.enterprise.id, name: schema.enterprise.name, uscc: schema.enterprise.usccNorm, district: schema.enterprise.district })
    .from(schema.enterprise)
    .where(isNull(schema.enterprise.usccNorm))
    .all()

  const dupList = db
    .select({ recordId: schema.recordEvent.recordId, n: count() })
    .from(schema.recordEvent)
    .groupBy(schema.recordEvent.recordId, schema.recordEvent.eventType, schema.recordEvent.year, schema.recordEvent.batchSeq)
    .having(sql`count(*) > 1`)
    .all()

  return [
    {
      kind: 'uscc_missing',
      label: '无统一社会信用代码(按名称归并)',
      n: usccMissing.length,
      samples: usccMissing.slice(0, 50),
    },
    {
      kind: 'duplicate_event',
      label: '同一记录下重复事件',
      n: dupList.length,
      samples: [],
    },
  ]
}

// ---------------------------------------------------------------------------
// 导出(不分页)
// ---------------------------------------------------------------------------

export interface ExportRow {
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  source: string
  events: string
}

/** 取全部匹配记录(用于导出),事件压成一行文本。 */
export function allRecords(db: Db, params: RecordQuery): ExportRow[] {
  const where = buildWhere(params)
  const base = db
    .select({
      recordId: schema.record.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(where)
    .orderBy(schema.record.titleCode, schema.enterprise.name)
    .all()

  const ids = base.map((r) => r.recordId)
  const events = ids.length
    ? db
        .select({
          recordId: schema.recordEvent.recordId,
          type: schema.recordEvent.eventType,
          year: schema.recordEvent.year,
          seq: schema.recordEvent.batchSeq,
        })
        .from(schema.recordEvent)
        .where(sql`${schema.recordEvent.recordId} in ${ids}`)
        .orderBy(schema.recordEvent.sortKey)
        .all()
    : []
  const byRecord = groupBy(events, (e) => e.recordId)

  const LABEL: Record<string, string> = { award: '认定', review: '复核', maintain: '维护', nurture: '入库培育' }
  return base.map((r) => ({
    name: r.name,
    uscc: r.uscc,
    district: r.district,
    titleCode: r.titleCode,
    source: r.source,
    events: (byRecord[r.recordId] ?? [])
      .map((e) => `${LABEL[e.type] ?? e.type} ${e.year ?? ''}${e.seq ? '-' + e.seq : ''}`.trim())
      .join('; '),
  }))
}
