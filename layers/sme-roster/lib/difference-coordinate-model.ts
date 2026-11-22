import { orderBy } from 'es-toolkit'
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

export function projectComparisonSources(rows: (Omit<ComparisonInputRow, 'titleCode' | 'direction'> & { titleCode: string; source: string | null })[], opts: ComparisonQuery) {
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
