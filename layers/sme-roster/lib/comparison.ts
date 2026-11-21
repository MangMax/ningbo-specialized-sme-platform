import { and, eq, inArray, isNull, min, ne, notExists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias as sqliteAlias } from 'drizzle-orm/sqlite-core'
import { orderBy } from 'es-toolkit'
import * as schema from '../../../db/schema'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record } from '../../../db/postgresql/ledger-tables'
import type { TitleCode } from '../../../db/titles'
import { TITLE_ORDER } from './labels'

export const COMPARISON_DIRECTIONS = ['missing_in_miit', 'extra_in_miit'] as const
export type ComparisonDirection = (typeof COMPARISON_DIRECTIONS)[number]
export type ComparisonCounts = Record<TitleCode, Record<ComparisonDirection, number>>

export interface ComparisonQuery {
  title?: string[]
  direction?: ComparisonDirection
}

/** 一行 = 企业 × 称号 × 差异方向;人工标注由后续票实现。 */
export interface ComparisonRow {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: TitleCode
  direction: ComparisonDirection
  curated: boolean
  evidence: {
    matchedBy: 'uscc'
    otherSideUscc: null
    currentCity: string | null
    regStatus: string | null
  }
}

export interface ComparisonResult {
  rows: ComparisonRow[]
  counts: ComparisonCounts
}

/**
 * 只读计算两侧统代差集。不读写文件、不物化、不做名称回退。
 * 记录存在即满足来源集合:不关联事件,因此不限年份且包含 nurture / review。
 * counts 始终涵盖全部称号与方向,筛选只作用于 rows。
 */
export function getComparison(
  db: BetterSQLite3Database<typeof schema>,
  opts: ComparisonQuery = {},
): ComparisonResult {
  const { enterprise, record } = schema
  const opposite = sqliteAlias(record, 'opposite')
  const other = sqliteAlias(enterprise, 'other')
  const localSide = eq(record.source, 'jxj')
  // Legacy nullable sources keep SQL's three-valued comparison and grouping.
  const opposingTitleAndSide = and(eq(opposite.titleCode, record.titleCode), or(
    and(localSide, ne(opposite.source, 'jxj')),
    and(ne(record.source, 'jxj'), eq(opposite.source, 'jxj')),
  ))
  const sameEnterprise = db.select({ id: opposite.id }).from(opposite)
    .where(and(eq(opposite.enterpriseId, record.enterpriseId), opposingTitleAndSide))
  const sameUscc = db.select({ id: opposite.id }).from(other)
    .innerJoin(opposite, eq(opposite.enterpriseId, other.id))
    .where(and(
      ne(other.id, record.enterpriseId),
      // Drizzle 0.45 has no COLLATE builder. Compare stored USCC bytes, including an empty string.
      eq(other.usccNorm, sql`${enterprise.usccNorm} COLLATE BINARY`),
      opposingTitleAndSide,
    ))
  // Probe the same enterprise first. MIN(id) preserves the legacy district
  // representative for records sharing an enterprise, title and side.
  const differences = db.$with('differences').as(db.select({ recordId: min(record.id).as('record_id') })
    .from(record)
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(and(inArray(record.titleCode, TITLE_ORDER), or(isNull(enterprise.usccNorm),
      and(notExists(sameEnterprise), notExists(sameUscc)))))
    .groupBy(record.enterpriseId, record.titleCode, localSide))

  const rows = db.with(differences).select({
    enterpriseId: enterprise.id,
    name: enterprise.name,
    uscc: enterprise.usccNorm,
    district: record.district,
    titleCode: record.titleCode,
    source: record.source,
    currentCity: enterprise.city,
    regStatus: enterprise.regStatus,
  }).from(differences)
    .innerJoin(record, eq(record.id, differences.recordId))
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .all()
  return projectComparisonSources(rows, opts)
}

type ComparisonInputRow = {
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: TitleCode
  direction: ComparisonDirection
  currentCity: string | null
  regStatus: string | null
}

export async function getPostgresComparison(db: Pick<NodePgDatabase, 'select' | '$with' | 'with'>, opts: ComparisonQuery = {}) {
  const opposite = alias(record, 'opposite')
  const other = alias(enterprise, 'other')
  const localSide = eq(record.source, 'jxj')
  const opposingTitleAndSide = and(eq(opposite.titleCode, record.titleCode), or(
    and(localSide, ne(opposite.source, 'jxj')),
    and(ne(record.source, 'jxj'), eq(opposite.source, 'jxj')),
  ))

  const sameEnterprise = db.select({ id: opposite.id }).from(opposite)
    .where(and(eq(opposite.enterpriseId, record.enterpriseId), opposingTitleAndSide))
  const sameUscc = db.select({ id: opposite.id }).from(other)
    .innerJoin(opposite, eq(opposite.enterpriseId, other.id))
    .where(and(
      ne(other.id, record.enterpriseId),
      // Drizzle 0.45 has no COLLATE expression builder. Use bytewise USCC equality.
      eq(other.usccNorm, sql`${enterprise.usccNorm} COLLATE "C"`),
      opposingTitleAndSide,
    ))
  const differences = db.$with('differences').as(db.select({ recordId: min(record.id).as('record_id') })
    .from(record)
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(and(inArray(record.titleCode, TITLE_ORDER), or(isNull(enterprise.usccNorm),
      and(notExists(sameEnterprise), notExists(sameUscc)))))
    .groupBy(record.enterpriseId, record.titleCode, localSide))

  const rows = await db.with(differences).select({
    enterpriseId: enterprise.id,
    name: enterprise.name,
    uscc: enterprise.usccNorm,
    district: record.district,
    titleCode: record.titleCode,
    source: record.source,
    currentCity: enterprise.city,
    regStatus: enterprise.regStatus,
  }).from(differences)
    .innerJoin(record, eq(record.id, differences.recordId))
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))

  return projectComparisonSources(rows, opts)
}

function projectComparisonSources(rows: (Omit<ComparisonInputRow, 'titleCode' | 'direction'> & { titleCode: string; source: string | null })[], opts: ComparisonQuery) {
  return projectComparison(rows.map(({ source, titleCode, ...row }) => ({
    ...row,
    titleCode: titleCode as TitleCode,
    direction: source === 'jxj' ? 'missing_in_miit' : 'extra_in_miit',
  })), opts)
}

function projectComparison(records: ComparisonInputRow[], opts: ComparisonQuery) {
  const counts = Object.fromEntries(
    TITLE_ORDER.map((code) => [code, { missing_in_miit: 0, extra_in_miit: 0 }]),
  ) as ComparisonCounts

  const differences = records.map((r): ComparisonRow => {
    counts[r.titleCode][r.direction]++
    return {
      enterpriseId: r.enterpriseId,
      name: r.name,
      uscc: r.uscc,
      district: r.district,
      titleCode: r.titleCode,
      direction: r.direction,
      curated: false,
      evidence: {
        matchedBy: 'uscc',
        otherSideUscc: null,
        currentCity: r.currentCity,
        regStatus: r.regStatus,
      },
    }
  })

  const rows = orderBy(
    differences.filter((r) =>
      (!opts.title?.length || opts.title.includes(r.titleCode)) &&
      (!opts.direction || r.direction === opts.direction),
    ),
    [(r) => TITLE_ORDER.indexOf(r.titleCode), (r) => r.name, (r) => r.enterpriseId, (r) => r.direction],
    ['asc', 'asc', 'asc', 'asc'],
  )
  return { rows, counts }
}
