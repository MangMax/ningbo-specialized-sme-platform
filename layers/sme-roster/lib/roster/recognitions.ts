import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import * as schema from '../../../../db/schema'
import { MAX_PAGE_SIZE } from '../query'
import { readRecognitionPage } from './recognition-read'
import type { RecognitionEntry } from './first-recognition'
import { computeTitleLifecycle, type LifecycleEvent } from './lifecycle'

type Db = BetterSQLite3Database<typeof schema>

/** §7.5 的一行:身份 + 该(企业 × 称号)的首次认定。 */
export interface RosterRecognitionRow extends RecognitionEntry {
  enterpriseId: number
  name: string
  uscc: string | null
  /** 与 §7.1 同一处口径(企业属地,为空时退回最早那条带属地的记录)。 */
  district: string | null
}

export interface RosterRecognitionFilter {
  /** 称号(多值,命中任一)。 */
  title?: string[]
  /**
   * **首次认定年份**(多值,命中任一)。
   *
   * 就叫 `year`:这个端点的主体**本来就是**首次认定,`year` 在这里没有第二种解释
   * (与 §7.1 的 `firstYear` 是同一个量 —— 那边名字更长是因为它得与**事件**年份区分开)。
   */
  year?: number[]
  /** 首次认定状态(多值:`confirmed` / `pending`)。 */
  status?: string[]
  page?: number
  pageSize?: number
}

export interface RosterRecognitionsResult {
  rows: RosterRecognitionRow[]
  counts: {
    /** 符合筛选的**企业 × 称号**数(= 行数,先于分页)。 */
    titlePairs: number
    /** 符合筛选的**企业**数(多称号企业在总数里只算一家)。 */
    enterprises: number
    /** 每个称号下符合筛选的**企业 × 称号**数(桶恒在,缺省为 0)。 */
    titles: Record<string, number>
  }
  page: number
  pageSize: number
}

const DEFAULT_PAGE_SIZE = 50

export function recognitionPageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = Number.isFinite(input.page) && (input.page as number) >= 1 ? Math.floor(input.page as number) : 1
  const size =
    Number.isFinite(input.pageSize) && (input.pageSize as number) >= 1
      ? Math.floor(input.pageSize as number)
      : DEFAULT_PAGE_SIZE
  return { page, pageSize: Math.min(size, MAX_PAGE_SIZE) }
}

/**
 * 首次认定清单。`counts` 与筛选**同口径**、且**先于分页**。
 *
 * 企业身份(名称 / 统代 / 属地)取自 `enterprise` 行 —— 与 §7.1 同源,不另做一次匹配。
 */
export function listRosterRecognitions(
  db: Db,
  filter: RosterRecognitionFilter = {},
): RosterRecognitionsResult {
  const { page, pageSize } = recognitionPageOf(filter)
  return db.transaction(() => readRecognitionPage(db, filter, page, pageSize))
}

export function readLedgerYears(db: Db): { eventYears: number[]; firstRecognitionYears: number[] } {
  const eventYears = new Set<number>()
  const firstRecognitionYears = new Set<number>()
  const rows = db.select({
    enterpriseId: schema.record.enterpriseId,
    titleCode: schema.record.titleCode,
    id: schema.recordEvent.id,
    eventType: schema.recordEvent.eventType,
    year: schema.recordEvent.year,
    decidedYear: schema.recordEvent.decidedYear,
    reviewOutcome: schema.recordEvent.reviewOutcome,
  }).from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .innerJoin(schema.recordEvent, eq(schema.recordEvent.recordId, schema.record.id))
    .orderBy(asc(schema.record.enterpriseId), asc(schema.record.titleCode), asc(schema.recordEvent.id))
    .all()
  let key: string | null = null
  let events: LifecycleEvent[] = []
  const finish = () => {
    const year = computeTitleLifecycle(events).firstRecognitionYear
    if (year != null) firstRecognitionYears.add(year)
  }
  for (const row of rows) {
    if (row.year != null) eventYears.add(row.year)
    const next = `${row.enterpriseId}/${row.titleCode}`
    if (key !== next) {
      if (key != null) finish()
      events = []
      key = next
    }
    events.push(row)
  }
  if (key != null) finish()

  return {
    eventYears: [...eventYears].sort((a, b) => a - b),
    firstRecognitionYears: [...firstRecognitionYears].sort((a, b) => a - b),
  }
}
