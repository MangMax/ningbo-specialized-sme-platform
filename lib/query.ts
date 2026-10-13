import { and, count, desc, eq, like, or, sql, type SQL } from 'drizzle-orm'
import { groupBy } from 'es-toolkit'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'

type Db = BetterSQLite3Database<typeof schema>

export interface RecordQuery {
  title?: string
  source?: string
  district?: string
  eventType?: string
  q?: string
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
