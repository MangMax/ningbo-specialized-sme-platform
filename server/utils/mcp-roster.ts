/**
 * RL-11 的企业总表/差异只读投影（契约 §9）。
 *
 * 名录只读工具包括 `list_enterprises` / `list_differences` / `query_records` /
 * `get_enterprise_detail`。它们**不鉴权**（沿用「只读不鉴权、写入必带 token」的既有分法）。
 *
 * ── 范围声明（重要）────────────────────────────────────────────────────
 * 契约 §7.1 / §7.3 的完整 REST 读模型由 RL-04 实现。本文件保留 RL-11 写入后的核对口径：
 * 身份 + 称号 + 已确认曾用名 + 差异的当前解释 + 证据指向。
 * 记录查询和企业详情分别由 `query_records` 与 `get_enterprise_detail` 提供，并直接复用 REST
 * 的参数解析和读模型。
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName } from '../../lib/domain'

type Db = BetterSQLite3Database<typeof schema>

export interface ListEnterprisesInput {
  /** 名称/曾用名关键词（走契约 §5 搜索口径：现名 + **已确认**曾用名）。 */
  q?: string
  /** 称号过滤（等值）。 */
  title?: string
  district?: string
  rosterState?: 'current' | 'removed_platform_only'
  page?: number
  pageSize?: number
}

export interface ListEnterpriseRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  city: string | null
  regStatus: string | null
  rosterState: 'current' | 'removed_platform_only'
  titles: string[]
  /** 仅 `confirmed` 的曾用名（未确认不参与搜索/展示）。 */
  aliasNames: string[]
}

export interface ListEnterprisesResult {
  rows: ListEnterpriseRow[]
  counts: { total: number; titles: Record<string, number> }
  page: number
  pageSize: number
}

const PAGE_SIZE_MAX = 200

function pageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = Number.isInteger(input.page) && (input.page as number) > 0 ? (input.page as number) : 1
  const rawSize = Number.isInteger(input.pageSize) && (input.pageSize as number) > 0 ? (input.pageSize as number) : 50
  return { page, pageSize: Math.min(rawSize, PAGE_SIZE_MAX) }
}

/**
 * 企业总表（**跨称号去重**：一行 = 一家企业，`titles` 是它拿过的称号）。
 * `rosterState` 按契约 §5 的派生口径做**最小**判定：有 jxj 记录且带事件 ⇒ `current`，
 * 否则 `removed_platform_only`（完整口径由 RL-04 实现）。
 */
export function listEnterprises(db: Db, input: ListEnterprisesInput = {}): ListEnterprisesResult {
  const enterprises = db.select().from(schema.enterprise).all()
  const records = db.select().from(schema.record).all()
  const events = db.select().from(schema.recordEvent).all()
  const aliases = db.select().from(schema.enterpriseAlias).all()

  const eventsByRecord = new Set(events.map((e) => e.recordId))
  const titlesByEnterprise = new Map<number, string[]>()
  const hasJxjEvent = new Set<number>()
  for (const record of records) {
    const list = titlesByEnterprise.get(record.enterpriseId) ?? []
    if (!list.includes(record.titleCode)) list.push(record.titleCode)
    titlesByEnterprise.set(record.enterpriseId, list)
    if (record.source === 'jxj' && eventsByRecord.has(record.id)) hasJxjEvent.add(record.enterpriseId)
  }
  const aliasNamesByEnterprise = new Map<number, string[]>()
  for (const alias of aliases) {
    if (alias.verificationStatus !== 'confirmed') continue
    const list = aliasNamesByEnterprise.get(alias.enterpriseId) ?? []
    if (!list.includes(alias.name)) list.push(alias.name)
    aliasNamesByEnterprise.set(alias.enterpriseId, list)
  }

  const term = input.q?.trim() ? normalizeName(input.q) : null
  const rows = enterprises
    .map((enterprise): ListEnterpriseRow => {
      const titles = (titlesByEnterprise.get(enterprise.id) ?? []).sort()
      const aliasNames = (aliasNamesByEnterprise.get(enterprise.id) ?? []).sort()
      return {
        enterpriseId: enterprise.id,
        name: enterprise.name,
        uscc: enterprise.usccNorm,
        district: enterprise.district,
        city: enterprise.city,
        regStatus: enterprise.regStatus,
        rosterState: hasJxjEvent.has(enterprise.id) ? 'current' : 'removed_platform_only',
        titles,
        aliasNames,
      }
    })
    .filter((row) => {
      if (input.title && !row.titles.includes(input.title)) return false
      if (input.district && row.district !== input.district) return false
      if (input.rosterState && row.rosterState !== input.rosterState) return false
      if (term) {
        const hit =
          normalizeName(row.name).includes(term) ||
          row.aliasNames.some((alias) => normalizeName(alias).includes(term))
        if (!hit) return false
      }
      return true
    })
    .sort((a, b) => a.enterpriseId - b.enterpriseId)

  const counts = { total: rows.length, titles: countTitles(rows) }
  const { page, pageSize } = pageOf(input)
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), counts, page, pageSize }
}

function countTitles(rows: ListEnterpriseRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) for (const title of row.titles) counts[title] = (counts[title] ?? 0) + 1
  return counts
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
