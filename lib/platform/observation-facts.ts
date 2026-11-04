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
/** Fields a source-specific typed projection actually models. A field absent from this
 * list is not authoritative: detail consumers must keep the legacy relation/raw column.
 * An empty list means this observation has no typed projection at all. */
export type PlatformFactField =
  | 'declareKind' | 'year' | 'appliedAt' | 'status' | 'batch' | 'awardBatchLabel'
  | 'province' | 'nameRaw' | 'usccRaw'
  | 'validityDateRaw' | 'maintenanceYear' | 'maintenanceBatch' | 'district' | 'awardNote' | 'titleRaw'

export interface PlatformObservationFact {
  /** Archive display facts, separate from the source content's null/identity contract. */
  archiveProcessFacts?: ArchiveProcessFacts
  relationId: number
  interface: PlatformFactInterface
  /** The content version's typed row id; null when the observation has no projection. */
  projectionVersionId: number | null
  /** The typed projection rule version; null when the observation has no projection. */
  projectionRuleVersion: string | null
  /** Fields owned by the typed row. Empty for a legacy/unprojected observation. */
  modeledFields: readonly PlatformFactField[]
  declareKind: string | null
  year: number | null
  appliedAt: string | null
  status: string | null
  batch: string | null
  awardBatchLabel: string | null
  province: string | null
  nameRaw: string | null
  usccRaw: string | null
  /** Recognized_list content fields; null for other interfaces and legacy rows. */
  validityDateRaw: string | null
  maintenanceYear: number | null
  maintenanceBatch: string | null
  district: string | null
  awardNote: string | null
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

const archiveProcessFields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const
export type ArchiveProcessFacts = Pick<PlatformObservationFact, typeof archiveProcessFields[number]>

/** Source-reader boundary for archive display consumers. Normalization has already
 * reconciled stored/raw conflicts. Only non-null modeled content may supplement it;
 * identities and all original content facts remain untouched. No raw is parsed here. */
export function withArchiveProcessFacts(
  fact: PlatformObservationFact,
  normalized: Partial<ArchiveProcessFacts>,
): PlatformObservationFact {
  const archiveProcessFacts = Object.fromEntries(archiveProcessFields.map(field => [
    field,
    fact.projectionVersionId != null && fact.modeledFields.includes(field)
      && fact[field] != null && !fact.normalizationConflicts.some(conflict => conflict.field === field)
      ? fact[field] : normalized[field] ?? null,
  ])) as ArchiveProcessFacts
  return { ...fact, archiveProcessFacts }
}
