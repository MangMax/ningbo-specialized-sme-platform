import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../db/schema'
import type { ComparisonDirection } from './comparison'
import { getCuratedComparison } from './curation'
import { readReconcile } from './reconcile'
import { readComparisonSummary } from './comparison-summary'

export interface ComparisonSummaryOptions {
  curatedPath: string; reconcilePath: string; enterpriseId?: number
  title?: string[]; direction?: ComparisonDirection; district?: string; q?: string
  showCurated: boolean; page: number; pageSize: number
}

/** One SQL snapshot across the entire original callback, using the same client
 * inside the transaction. Files retain their independent, fresh read semantics. */
export function readWholeComparisonSummary(db: BetterSQLite3Database<typeof schema>, input: ComparisonSummaryOptions) {
  return db.transaction(() => {
    const result = getCuratedComparison(db, input.curatedPath)
    const scopedResult = input.enterpriseId == null ? result : { ...result, rows: result.rows.filter(row => row.enterpriseId === input.enterpriseId) }
    return readComparisonSummary(db, scopedResult, readReconcile(input.reconcilePath), {
      title: input.title, direction: input.direction, district: input.district,
      q: input.q, showCurated: input.showCurated,
    }, input.page, input.pageSize)
  })
}
