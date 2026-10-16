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
    // **小巨人双向对比已启用**(用户 2026-10-16 裁决,RL-04 落地)。
    //
    // 两侧 = 经信局**历年小巨人名单**(RL-02 导入,历史批次 2019–2025 的**权威来源**)
    // vs 工信部**导出表**(**采集时点现状**)。旧代码在这里硬排除小巨人,
    // 依据是「经信局不发布小巨人」—— 该说法已被 RL-02 的历年名单**证伪**,
    // 故排除一并去掉(`tests/comparison.test.ts` 的旧期望随之更新,是有意变更)。
    //
    // 硬边界不变:平台导出**永不改写**公布历史;未匹配平台的公布条目**仍须保留**。
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
