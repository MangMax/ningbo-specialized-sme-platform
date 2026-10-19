/**
 * RL-11 名录只读工具的投影（契约 §9）。
 *
 * 名录只读工具包括 `list_enterprises` / `list_differences` / `query_records` /
 * `get_enterprise_detail`。它们**不鉴权**（沿用「只读不鉴权、写入必带 token」的既有分法）。
 *
 * ── 范围声明（重要）────────────────────────────────────────────────────
 * `list_enterprises` 直接复用 §7.1 的 REST 总表读模型，保证首次认定、出处、生命周期摘要、
 * 计数和分页与 REST 一致。`list_differences` 保留 RL-11 写入后的核对投影：差异当前解释与证据。
 * 记录查询和企业详情分别由 `query_records` 与 `get_enterprise_detail` 提供，并复用 REST 读模型。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import {
  listRosterEnterprises,
  type RosterEnterpriseRow,
  type RosterEnterprisesResult,
} from '../../lib/roster/enterprise-roster'
import type { FirstRecognitionStatus } from '../../lib/roster/first-recognition'

type Db = BetterSQLite3Database<typeof schema>

export interface ListEnterprisesInput {
  /** 名称/曾用名关键词（走契约 §5 搜索口径：现名 + **已确认**曾用名）。 */
  q?: string
  /** 称号过滤（等值）。 */
  title?: string | string[]
  district?: string
  rosterState?: 'current' | 'removed_platform_only'
  /** 首次正式认定年份(多值,不同于事件年份)。 */
  firstYear?: number[]
  /** 首次认定状态(多值,使用共享首次认定判定)。 */
  firstStatus?: FirstRecognitionStatus[]
  page?: number
  pageSize?: number
}

/** MCP 与 REST 共享企业总表的完整行形状。 */
export type ListEnterpriseRow = RosterEnterpriseRow
export type ListEnterprisesResult = RosterEnterprisesResult

const PAGE_SIZE_MAX = 200

function pageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = Number.isInteger(input.page) && (input.page as number) > 0 ? (input.page as number) : 1
  const rawSize = Number.isInteger(input.pageSize) && (input.pageSize as number) > 0 ? (input.pageSize as number) : 50
  return { page, pageSize: Math.min(rawSize, PAGE_SIZE_MAX) }
}

/**
 * 企业总表（**跨称号去重**：一行 = 一家企业，`titles` 是它拿过的称号）。
 * 所有筛选、首次认定字段和计数都由 REST 共用读模型计算，避免 MCP 与 UI/HTTP 结果分叉。
 */
export function listEnterprises(db: Db, input: ListEnterprisesInput = {}): ListEnterprisesResult {
  return listRosterEnterprises(db, enterpriseListFilter(input))
}

export function enterpriseListFilter(input: ListEnterprisesInput = {}) {
  return {
    q: input.q,
    title: input.title == null ? undefined : Array.isArray(input.title) ? input.title : [input.title],
    district: input.district,
    rosterState: input.rosterState,
    firstYear: input.firstYear,
    firstStatus: input.firstStatus,
    page: input.page,
    pageSize: input.pageSize,
  }
}

export interface ListDifferencesInput {
  title?: string
  direction?: 'missing_in_miit' | 'extra_in_miit'
  status?: string
  page?: number
  pageSize?: number
}

export interface ListDifferenceRow {
  enterpriseId: number
  name: string
  titleCode: string
  direction: string
  status: string
  reasonCode: string | null
  measureCode: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  verificationStatus: string
  recordedAt: string
  evidence: { queryId: number; queriedAt: string; interface: string; status: string } | null
}

export interface ListDifferencesResult {
  rows: ListDifferenceRow[]
  counts: Record<string, Record<string, number>>
}

/**
 * 差异与解释。**当前解释 = `recordedAt` 最新那条**（旧解释不丢，只是不再出现在这里）。
 */
export function listDifferences(db: Db, input: ListDifferencesInput = {}): ListDifferencesResult {
  const enterprises = db.select().from(schema.enterprise).all()
  const nameById = new Map(enterprises.map((e) => [e.id, e.name]))
  const queries = db.select().from(schema.platformQuery).all()
  const queryById = new Map(queries.map((q) => [q.id, q]))

  // 每 (企业, 称号, 方向) 取最新时点的那条 —— 时态化的「当前解释」。
  const current = new Map<string, (typeof schema.differenceReason)['$inferSelect']>()
  for (const difference of db.select().from(schema.differenceReason).all()) {
    const key = `${difference.enterpriseId}|${difference.titleCode}|${difference.direction}`
    const kept = current.get(key)
    if (!kept || difference.recordedAt > kept.recordedAt) current.set(key, difference)
  }

  const all = [...current.values()].map((difference): ListDifferenceRow => {
    const query = difference.evidenceQueryId != null ? queryById.get(difference.evidenceQueryId) : undefined
    const hasMovedIn =
      difference.movedInCity != null ||
      difference.movedInTitleCode != null ||
      difference.movedInYear != null ||
      difference.movedInBatch != null
    return {
      enterpriseId: difference.enterpriseId,
      name: nameById.get(difference.enterpriseId) ?? '',
      titleCode: difference.titleCode,
      direction: difference.direction,
      status: difference.status,
      reasonCode: difference.reasonCode,
      measureCode: difference.measureCode,
      movedIn: hasMovedIn
        ? {
            city: difference.movedInCity,
            titleCode: difference.movedInTitleCode,
            year: difference.movedInYear,
            batch: difference.movedInBatch,
          }
        : null,
      verificationStatus: difference.verificationStatus,
      recordedAt: difference.recordedAt,
      evidence: query
        ? { queryId: query.id, queriedAt: query.queriedAt, interface: query.interface, status: query.status }
        : null,
    }
  })

  const filtered = all
    .filter((row) => {
      if (input.title && row.titleCode !== input.title) return false
      if (input.direction && row.direction !== input.direction) return false
      if (input.status && row.status !== input.status) return false
      return true
    })
    .sort((a, b) => (a.enterpriseId - b.enterpriseId) || a.titleCode.localeCompare(b.titleCode))

  const counts: Record<string, Record<string, number>> = {}
  for (const row of filtered) {
    counts[row.titleCode] ??= {}
    counts[row.titleCode]![row.direction] = (counts[row.titleCode]![row.direction] ?? 0) + 1
  }

  const { page, pageSize } = pageOf(input)
  return { rows: filtered.slice((page - 1) * pageSize, page * pageSize), counts }
}
