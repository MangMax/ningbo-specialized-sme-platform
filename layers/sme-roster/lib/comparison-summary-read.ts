import type { ComparisonDirection } from './comparison-model'

export interface ComparisonSummaryOptions {
  curatedPath: string; reconcilePath: string; enterpriseId?: number
  title?: string[]; direction?: ComparisonDirection; district?: string; q?: string
  showCurated: boolean; page: number; pageSize: number
}

/** One SQL snapshot across the entire original callback, using the same client
 * inside the transaction. Files retain their independent, fresh read semantics. */
