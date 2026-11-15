// Frozen b42ea8517bb9c6f5cd6a3dad31b1cfb45e5db024 reference.
// Only relative imports and exported function name differ from that source.
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { orderBy } from 'es-toolkit'
import * as schema from '../../../../db/schema'
import type { TitleCode } from '../../../../db/titles'
import { TITLE_ORDER } from '../../../../lib/labels'

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
export function readBaselineComparison(
  db: BetterSQLite3Database<typeof schema>,
  opts: ComparisonQuery = {},
): ComparisonResult {
  // Matched source rows stay inside SQLite. Keep the legacy jxj / everything-else
  // partition and binary equality of stored USCC (including an empty string).
  // The legacy record table scan kept its first row; MIN(id) retains that
  // representative district for historical non-jxj sources sharing a side.
  const records = db.all<{
    enterpriseId: number
    name: string
    uscc: string | null
    district: string | null
    titleCode: TitleCode
    direction: ComparisonDirection
    currentCity: string | null
    regStatus: string | null
  }>(sql`
    with differences as (
      select min(r.id) as recordId
      from record r
      join enterprise e on e.id = r.enterprise_id
      where r.title_code in ${TITLE_ORDER}
        and (e.uscc_norm is null or not exists (
          select 1 from enterprise other
          join record opposite on opposite.enterprise_id = other.id
          where other.uscc_norm = e.uscc_norm collate binary
            and opposite.title_code = r.title_code
            and (opposite.source = 'jxj') <> (r.source = 'jxj')
        ))
      group by r.enterprise_id, r.title_code, (r.source = 'jxj')
    )
    select e.id as enterpriseId, e.name, e.uscc_norm as uscc,
      r.district, r.title_code as titleCode,
      case when r.source = 'jxj' then 'missing_in_miit' else 'extra_in_miit' end as direction,
      e.city as currentCity, e.reg_status as regStatus
    from differences d
    join record r on r.id = d.recordId
    join enterprise e on e.id = r.enterprise_id
  `)
  const counts = Object.fromEntries(
    TITLE_ORDER.map((code) => [code, { missing_in_miit: 0, extra_in_miit: 0 }]),
  ) as ComparisonCounts

  const differences = records.map((r): ComparisonRow => {
    // **小巨人双向对比已启用**(用户 2026-10-16 裁决,RL-04 落地)。
    //
    // 两侧 = 经信局**历年小巨人名单**(RL-02 导入,历史批次 2019–2025 的**权威来源**)
    // vs 工信部**导出表**(**采集时点现状**)。旧代码在这里硬排除小巨人,
    // 依据是「经信局不发布小巨人」—— 该说法已被 RL-02 的历年名单**证伪**,
    // 故排除一并去掉(`tests/comparison.test.ts` 的旧期望随之更新,是有意变更)。
    //
    // 硬边界不变:平台导出**永不改写**公布历史;未匹配平台的公布条目**仍须保留**。
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
