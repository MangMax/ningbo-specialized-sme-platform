import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { orderBy } from 'es-toolkit'
import * as schema from '../../../db/schema'
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
  // Matched source rows stay inside the database. Keep the legacy jxj / everything-else
  // partition and binary equality of stored USCC (including an empty string).
  // The legacy record table scan kept its first row; MIN(id) retains that
  // representative district for historical non-jxj sources sharing a side.
  // A non-null USCC always matches itself: try the same enterprise's records
  // before the legacy cross-enterprise binary-USCC lookup.
  return projectComparison(db.all<ComparisonInputRow>(comparisonInput(sql`binary`, sql`e.id`)), opts)
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

function comparisonInput(collation: SQL, enterpriseId: SQL) {
  return sql`
    with differences as (
      select min(r.id) as recordId
      from record r
      join enterprise e on e.id = r.enterprise_id
      where r.title_code in ${TITLE_ORDER}
        and (e.uscc_norm is null or (
          not exists (
            select 1 from record opposite
            where opposite.enterprise_id = r.enterprise_id
              and opposite.title_code = r.title_code
              and (opposite.source = 'jxj') <> (r.source = 'jxj')
          ) and not exists (
            select 1 from enterprise other
            join record opposite on opposite.enterprise_id = other.id
            where other.id <> r.enterprise_id
              and other.uscc_norm = e.uscc_norm collate ${collation}
              and opposite.title_code = r.title_code
              and (opposite.source = 'jxj') <> (r.source = 'jxj')
          )
        ))
      group by r.enterprise_id, r.title_code, (r.source = 'jxj')
    )
    select ${enterpriseId} as "enterpriseId", e.name, e.uscc_norm as uscc,
      r.district, r.title_code as "titleCode",
      case when r.source = 'jxj' then 'missing_in_miit' else 'extra_in_miit' end as direction,
      e.city as "currentCity", e.reg_status as "regStatus"
    from differences d
    join record r on r.id = d.recordId
    join enterprise e on e.id = r.enterprise_id
  `
}

export async function getPostgresComparison(db: Pick<NodePgDatabase,'execute'>, opts: ComparisonQuery = {}) {
  const { rows } = await db.execute<ComparisonInputRow>(comparisonInput(sql`"C"`, sql`e.id::float8`))
  return projectComparison(rows, opts)
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
