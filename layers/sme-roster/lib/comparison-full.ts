import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../db/schema'
import { attachPlatformEvidence } from './comparison-platform'
import { readComparisonSummary } from './comparison-summary'
import type { ComparisonSummaryOptions } from './comparison-summary-read'
import { getCuratedComparison } from './curation'
import { attachReconcile, readReconcile } from './reconcile'

/** Select and count on scalars before loading the requested page's original evidence. */
export function readWholeComparisonFull(db: BetterSQLite3Database<typeof schema>, input: ComparisonSummaryOptions) {
  return db.transaction(() => {
    const result = getCuratedComparison(db, input.curatedPath)
    const scoped = input.enterpriseId == null ? result : { ...result, rows: result.rows.filter(row => row.enterpriseId === input.enterpriseId) }
    const reconcile = readReconcile(input.reconcilePath)
    const summary = readComparisonSummary(db, scoped, reconcile, {
      title: input.title, direction: input.direction, district: input.district, q: input.q, showCurated: input.showCurated,
    }, input.page, input.pageSize)
    const key = (row: { enterpriseId: number; titleCode: string; direction: string }) => JSON.stringify([row.enterpriseId, row.titleCode, row.direction])
    const selected = new Set(summary.rows.map(key))
    const rows = attachPlatformEvidence(attachReconcile(scoped.rows.filter(row => selected.has(key(row))), reconcile), db)
    return { rows, total: summary.total, counts: summary.counts, curatedCounts: summary.curatedCounts,
      platform: summary.platform, reconcile: summary.reconcile }
  })
}
