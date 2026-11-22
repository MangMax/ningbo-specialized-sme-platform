import { and, eq, inArray, isNull, min, ne, notExists, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias as sqliteAlias } from 'drizzle-orm/sqlite-core'
import * as schema from '../../../db/schema'
import { TITLE_ORDER } from './labels'
import { projectComparisonSources, type ComparisonQuery, type ComparisonResult } from './comparison-model'

export { COMPARISON_DIRECTIONS, type ComparisonDirection, type ComparisonCounts, type ComparisonQuery, type ComparisonRow, type ComparisonResult } from './comparison-model'
export { getPostgresComparison } from './comparison-heads-postgres'

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
