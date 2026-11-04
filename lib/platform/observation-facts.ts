import type { PlatformNormalizationConflict } from './normalization'

/** The three modeled platform sources. Their typed projections have different fields;
 * consumers receive this common observation fact and never read projection tables directly. */
export type PlatformFactInterface = 'apply_list' | 'business_list' | 'recognized_list'

/**
 * Observation-level fact from a source-specific typed projection, with a legacy
 * normalization fallback for historical rows that predate/omit the typed projection.
 *
 * `year` is the source's explicit business/declaration year. For `recognized_list` it is
 * the archived stored year when present; a directory maintenance year is not a process
 * business year and is never exposed here as one.
 */
export interface PlatformObservationFact {
  relationId: number
  interface: PlatformFactInterface
  declareKind: string | null
  year: number | null
  appliedAt: string | null
  status: string | null
  batch: string | null
  awardBatchLabel: string | null
  province: string | null
  usccRaw: string | null
  /** Row-level title raw value. Modeled only by recognized_list; legacy recognized rows
   * may expose rawFields.rdjb to preserve their existing conflict reporting. */
  titleRaw: string | null
  normalizationConflicts: PlatformNormalizationConflict[]
}

/** Legacy raw row title is evidence only for the interface that actually models it. */
export function legacyRowTitle(rawFields: Record<string, unknown> | null | undefined): string | null {
  const value = rawFields?.rdjb
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
