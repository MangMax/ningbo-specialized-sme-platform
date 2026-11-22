import {
  platformSourceCellValue,
  type PlatformSourceValues,
} from '../../../../db/postgresql/platform-source-values'
import { normalizeDeclareKind, processFactsFromRow } from './identity'
import { platformNormalizationConflict, type PlatformNormalizationConflict } from './normalization'
import type { ArchiveProcessFacts, PlatformFactInterface } from './observation-facts'
import type { PlatformRow } from './types'

type VersionSourceFields = Pick<PlatformSourceValues, 'titleRaw' | 'status' | 'declareKind' | 'appliedAt' | 'batch' | 'awardBatchLabel' | 'province'> & {
  declarationYear?: number | null
  businessYear?: number | null
}

export function platformObservationVersionDefaults(source: PlatformFactInterface, version: VersionSourceFields | null): PlatformSourceValues {
  if (version === null) return {}
  const { titleRaw, status, declareKind, appliedAt, batch, awardBatchLabel, province } = version
  if (source === 'recognized_list') return { titleRaw }
  if (source === 'apply_list') return { titleRaw, status, declareKind, appliedAt, year: version.declarationYear }
  return { titleRaw, status, declareKind, appliedAt, year: version.businessYear, batch, awardBatchLabel, province }
}

export function platformObservationSourceValue(
  sourceValues: PlatformSourceValues | null,
  defaults: PlatformSourceValues,
  key: keyof PlatformSourceValues,
) {
  if (sourceValues === null) return null
  return platformSourceCellValue(Object.hasOwn(sourceValues, key) ? sourceValues[key] : defaults[key])
}

const comparisonFields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const
type Value = ReturnType<typeof platformSourceCellValue>

const trimmedText = (value: Value) => typeof value === 'string' ? value.trim() || null : null
const safeYear = (value: Value) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null

export function platformObservationComparison(
  source: PlatformFactInterface,
  sourceValues: PlatformSourceValues | null,
  defaults: PlatformSourceValues,
  businessFields: Record<string, unknown> | null,
) {
  const exact = (key: keyof PlatformSourceValues) => platformObservationSourceValue(sourceValues, defaults, key)
  const process = source !== 'recognized_list'
  const status = exact('status')
  const kind = exact('declareKind')
  const stored: ArchiveProcessFacts = {
    province: trimmedText(exact('province')),
    status: source === 'business_list' && Buffer.isBuffer(status) ? status : trimmedText(status),
    batch: trimmedText(exact('batch')),
    declareKind: process ? normalizeDeclareKind(kind) : trimmedText(kind),
    appliedAt: trimmedText(exact('appliedAt')),
    awardBatchLabel: trimmedText(exact('awardBatchLabel')),
    year: safeYear(exact('year')),
  }
  const parsed = process ? processFactsFromRow((businessFields ?? {}) as PlatformRow) : null
  const normalizationConflicts: PlatformNormalizationConflict[] = []
  const normalized = Object.fromEntries(comparisonFields.map(field => {
    const old = stored[field]
    const raw = (field === 'year' ? safeYear(parsed?.year ?? null) : parsed?.[field]) ?? null
    if (old !== null && raw !== null && old !== raw) {
      normalizationConflicts.push(platformNormalizationConflict(field, old, raw))
      return [field, null]
    }
    return [field, old ?? raw]
  })) as ArchiveProcessFacts

  const rawTitle = businessFields?.rdjb
  const sqlTitle = exact('titleRaw')

  return {
    normalized,
    normalizationConflicts,
    sqlFactTitle: typeof sqlTitle === 'string' ? sqlTitle : null,
    sourceTitle: typeof rawTitle === 'string' || typeof rawTitle === 'number' ? rawTitle : null,
  }
}

export type PlatformObservationComparison = ReturnType<typeof platformObservationComparison>
