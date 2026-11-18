/**
 * **首次认定清单**(契约 §7.5)—— 一行 = 一个**企业 × 称号**。
 *
 * ── 单位(页面与导出都要说清)────────────────────────────────────────────
 * 行是「企业 × 称号」,不是企业:一家企业在三个称号上首次认定过三次,就是三行。
 * 所以计数**两个都给**:`counts.titlePairs`(企业 × 称号)与 `counts.enterprises`(企业数)。
 * 只报一个,用户就会把前者当成后者(或反过来)。
 *
 * ── 计算只有一处 ────────────────────────────────────────────────────────
 * 与企业视图共用 `computeTitleLifecycle` / 首认判据;取数走独立的轻量读模型。
 * 全局筛选与统计只扫描 award 标量,分页后才读取所选事件的全部出处。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, asc, eq, sql } from 'drizzle-orm'
import * as schema from '../../db/schema'
import { MAX_PAGE_SIZE } from '../../layers/sme-roster/lib/query'
import { readRecognitionPage } from './recognition-read'
import type { RecognitionEntry } from './first-recognition'
import { computeTitleLifecycle, type LifecycleEvent } from '../../layers/sme-roster/lib/roster/lifecycle'

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

export interface FirstRecognitionYearFilter {
  title?: string
  district?: string
  source?: string
}

const DEFAULT_PAGE_SIZE = 50

function pageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
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
  const { page, pageSize } = pageOf(filter)
  return db.transaction(() => readRecognitionPage(db, filter, page, pageSize))
}

/**
 * 可选的首次认定年份,计数单位为企业 × 称号。
 *
 * 年份来自同一份 `RecognitionEntry`,因此采用生命周期里的 `decidedYear ?? year` 语义。
 * `title` / `district` / `source` 沿用 `/api/stats` 的记录筛选:先看企业是否有符合筛选的
 * 对应称号记录,再按该称号唯一的首次认定年份计一次。
 */
export function getFirstRecognitionYearBuckets(
  db: Db,
  filter: FirstRecognitionYearFilter = {},
): { key: string; n: number }[] {
  const counts = new Map<number, number>()
  // Only lifecycle scalars are required. Never load platform archives or source
  // evidence just to populate the global header and homepage year picker.
  // A matching record admits the pair, while its earliest award still considers
  // every source for that same enterprise/title, as in the original profiles.
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
    .where(and(
      filter.title ? eq(schema.record.titleCode, filter.title) : undefined,
      filter.district || filter.source ? sql`exists (
        select 1 from record matching where matching.enterprise_id=${schema.record.enterpriseId}
        and matching.title_code=${schema.record.titleCode}
        and ${filter.district ? sql`matching.district=${filter.district}` : sql`1`}
        and ${filter.source ? sql`matching.source=${filter.source}` : sql`1`}
      )` : undefined,
    ))
    .orderBy(asc(schema.record.enterpriseId), asc(schema.record.titleCode), asc(schema.recordEvent.id))
    .all()
  let key: string | null = null
  let events: LifecycleEvent[] = []
  const finish = () => {
    const year = computeTitleLifecycle(events).firstRecognitionYear
    if (year != null) counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  for (const row of rows) {
    const next = `${row.enterpriseId}/${row.titleCode}`
    if (key !== next) {
      if (key != null) finish()
      events = []
      key = next
    }
    events.push(row)
  }
  if (key != null) finish()

  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([year, n]) => ({ key: String(year), n }))
}
