import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { groupBy, orderBy, partition, uniqBy } from 'es-toolkit'
import * as schema from '../db/schema'
import type { TitleCode } from '../db/titles'
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
  const records = db
    .select({
      enterpriseId: schema.enterprise.id,
      name: schema.enterprise.name,
      uscc: schema.enterprise.usccNorm,
      district: schema.record.district,
      titleCode: schema.record.titleCode,
      source: schema.record.source,
      currentCity: schema.enterprise.city,
      regStatus: schema.enterprise.regStatus,
    })
    .from(schema.record)
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .all()
  const byTitle = groupBy(records, (r) => r.titleCode)
  const counts = Object.fromEntries(
    TITLE_ORDER.map((code) => [code, { missing_in_miit: 0, extra_in_miit: 0 }]),
  ) as ComparisonCounts

  const differences = TITLE_ORDER.flatMap((code): ComparisonRow[] => {
    // 小巨人的经信局侧来源(历年名单,RL-02)目前仍不参与比对 —— 现有行为保持不变;
    // 是否解除排除由 RL-04 按用户裁决处理(2026-10-16:用户选择启用双向对比)。
    // 注意:不再写成「经信局不发布小巨人」—— 该说法已被 RL-02 的历年名单证伪。
    if (code === 'little_giant') return []
    const titleCode = code as TitleCode
    const [jxj, miit] = partition(byTitle[code] ?? [], (r) => r.source === 'jxj')
    const sides = [jxj, miit].map((rows) => uniqBy(rows, (r) => r.enterpriseId))
    return COMPARISON_DIRECTIONS.flatMap((direction, index) => {
      const otherKeys = new Set(sides[1 - index]!.map((r) => r.uscc).filter((key) => key !== null))
      const unmatched = sides[index]!.filter((r) => r.uscc === null || !otherKeys.has(r.uscc))
      counts[titleCode][direction] = unmatched.length
      return unmatched.map((r) => ({
        enterpriseId: r.enterpriseId,
        name: r.name,
        uscc: r.uscc,
        district: r.district,
        titleCode,
        direction,
        curated: false,
        evidence: {
          matchedBy: 'uscc' as const,
          otherSideUscc: null,
          currentCity: r.currentCity,
          regStatus: r.regStatus,
        },
      }))
    })
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
