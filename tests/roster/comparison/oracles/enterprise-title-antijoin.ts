import { orderBy } from 'es-toolkit'
import type { ComparisonRow, ComparisonCounts, ComparisonQuery } from '../../../../layers/sme-roster/lib/comparison-model'
import type { TitleCode } from '../../../../db/titles'
import { TITLE_ORDER } from '../../../../layers/sme-roster/lib/labels'

type Source = {
  enterpriseId: number
  titleCode: string
  source: string
  name: string
  district: string | null
  uscc: string | null
  currentCity: string | null
  regStatus: string | null
}

/** The caller supplies source records in ID order. Compare the literal source sets in memory. */
export function readBaselineComparison(sources: readonly Source[], opts: ComparisonQuery = {}) {
  const counts = Object.fromEntries(TITLE_ORDER.map(code => [code, { missing_in_miit: 0, extra_in_miit: 0 }])) as ComparisonCounts
  const differences = new Map<string, ComparisonRow>()
  for (const row of sources) {
    const titleCode = row.titleCode as TitleCode
    if (!TITLE_ORDER.includes(titleCode)) continue
    const published = row.source === 'jxj'
    if (row.uscc !== null && sources.some(other =>
      other.uscc === row.uscc && other.titleCode === titleCode && (other.source === 'jxj') !== published,
    )) continue
    const direction = published ? 'missing_in_miit' : 'extra_in_miit'
    const key = JSON.stringify([row.enterpriseId, titleCode, direction])
    if (differences.has(key)) continue
    counts[titleCode][direction]++
    differences.set(key, {
      enterpriseId: row.enterpriseId, name: row.name, uscc: row.uscc, district: row.district, titleCode, direction, curated: false,
      evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: row.currentCity, regStatus: row.regStatus },
    })
  }
  const rows = orderBy(
    [...differences.values()].filter(row => (!opts.title?.length || opts.title.includes(row.titleCode))
      && (!opts.direction || row.direction === opts.direction)),
    [row => TITLE_ORDER.indexOf(row.titleCode), row => row.name, row => row.enterpriseId, row => row.direction],
    ['asc', 'asc', 'asc', 'asc'],
  )
  return { rows, counts }
}
