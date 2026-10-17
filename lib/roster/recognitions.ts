/**
 * **首次认定清单**(契约 §7.5)—— 一行 = 一个**企业 × 称号**。
 *
 * ── 单位(页面与导出都要说清)────────────────────────────────────────────
 * 行是「企业 × 称号」,不是企业:一家企业在三个称号上首次认定过三次,就是三行。
 * 所以计数**两个都给**:`counts.titlePairs`(企业 × 称号)与 `counts.enterprises`(企业数)。
 * 只报一个,用户就会把前者当成后者(或反过来)。
 *
 * ── 计算只有一处 ────────────────────────────────────────────────────────
 * 这里的每一行都来自 `readRosterProfiles` 里 `buildProfile` 算好的首次认定
 * (与 §7.1 的 `firstRecognition`、§7.2 的 `recognitions` 是**同一批对象**)。
 * 本文件只做三件事:摊平、筛选、分页。
 *
 * 为什么不能自己再算一遍「哪条是最早的 award」:那是三年复核规则的地基,
 * 两处各算一次迟早会漂移 —— 到那时总表说 2021、首次认定清单说 2022,谁也说不清哪个对。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { TITLE_ORDER } from '../labels'
import { MAX_PAGE_SIZE } from '../query'
import { effectiveDistrict, readRosterProfiles } from './enterprise-roster'
import { matchesRecognitionQuery, type RecognitionEntry } from './first-recognition'

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

/** 称号等级序(与总表同一主序),未知代号排最后。 */
function titleRank(code: string): number {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? TITLE_ORDER.length : i
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
  const { profiles } = readRosterProfiles(db)
  // 端点侧的参数名 → 判据形状:`year` / `status` 在这里就叫这个名字(这个端点的主体本来就是
  // 首次认定,`year` 没有第二种解释);总表那边同一个量叫 `firstYear` / `firstStatus`。
  // **只做一次改名,判据本身是同一个函数** —— 否则同一个 URL 在两个端点上会给出两批人。
  const query = { title: filter.title, firstYear: filter.year, firstStatus: filter.status }

  const rows: RosterRecognitionRow[] = []
  for (const profile of profiles) {
    for (const entry of profile.recognitions) {
      if (!matchesRecognitionQuery(entry, query)) continue
      rows.push({
        ...entry,
        enterpriseId: profile.enterprise.id,
        name: profile.enterprise.name,
        uscc: profile.enterprise.usccNorm,
        district: effectiveDistrict(profile),
      })
    }
  }

  rows.sort(
    (a, b) =>
      titleRank(a.titleCode) - titleRank(b.titleCode) ||
      a.name.localeCompare(b.name) ||
      a.enterpriseId - b.enterpriseId,
  )

  const byTitle: Record<string, number> = Object.fromEntries(TITLE_ORDER.map((code) => [code, 0]))
  for (const row of rows) byTitle[row.titleCode] = (byTitle[row.titleCode] ?? 0) + 1

  const { page, pageSize } = pageOf(filter)
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    counts: {
      titlePairs: rows.length,
      enterprises: new Set(rows.map((r) => r.enterpriseId)).size,
      titles: byTitle,
    },
    page,
    pageSize,
  }
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
  const { profiles } = readRosterProfiles(db)
  const counts = new Map<number, number>()

  for (const profile of profiles) {
    const matchingTitles = new Set(
      profile.records
        .filter(
          (record) =>
            (!filter.title || record.titleCode === filter.title) &&
            (!filter.district || record.district === filter.district) &&
            (!filter.source || record.source === filter.source),
        )
        .map((record) => record.titleCode),
    )

    for (const entry of profile.recognitions) {
      if (entry.firstYear == null || !matchingTitles.has(entry.titleCode)) continue
      counts.set(entry.firstYear, (counts.get(entry.firstYear) ?? 0) + 1)
    }
  }

  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([year, n]) => ({ key: String(year), n }))
}
