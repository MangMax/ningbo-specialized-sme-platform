import { processFactsFromRow, type PlatformRelationRecord } from './identity'
import type { PlatformRow } from './types'

/** Allowlist for readers that must avoid materializing unrelated archived payloads. */
export const PLATFORM_PROCESS_RAW_KEYS = ['szsfmc', 'cszt', 'whpc', 'sblx', 'sqsj', 'personuuid', 'year', 'rdjb'] as const

/** Decode SQLite's multi-path json_extract array, retaining JSON value types. */
export function platformProcessRawFromJson(value: string): Record<string, unknown> {
  const values: unknown[] = JSON.parse(value)
  return Object.fromEntries(PLATFORM_PROCESS_RAW_KEYS.map((key, index) => [key, values[index]]))
}

const fields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const
type Field = typeof fields[number]
type Facts = Pick<PlatformRelationRecord, Field>
export interface PlatformNormalizationConflict {
  field: Field
  storedValue: string | number
  rawValue: string | number
}
type ArchivedRelation = Partial<Facts> & { rawFields?: Record<string, unknown> | null }

/** Shared archive/read mapping; identity and raw evidence stay untouched.
 * Conflicting nonempty facts cannot support positive decisions; both values stay explicit.
 * queryBusList remains a recognition snapshot, never a process row.
 */
export function normalizePlatformRelation<T extends ArchivedRelation>(source: string, relation: T) {
  const parsed = source === 'apply_list' || source === 'business_list'
    ? processFactsFromRow((relation.rawFields ?? {}) as PlatformRow)
    : null
  const normalizationConflicts: PlatformNormalizationConflict[] = []
  const facts = Object.fromEntries(fields.map(field => {
    // Use the raw parser's exact allowlist on both sides, only for process rows.
    const stored = parsed && field === 'declareKind'
      ? processFactsFromRow({ sblx: relation.declareKind ?? '' }).declareKind
      : relation[field]
    const existing = typeof stored === 'string' ? stored.trim() || null : stored ?? null
    const raw = parsed?.[field] ?? null
    if (existing != null && raw != null && existing !== raw) {
      normalizationConflicts.push({ field, storedValue: existing, rawValue: raw })
      return [field, null]
    }
    return [field, existing ?? raw]
  })) as Facts
  return { ...relation, ...facts, normalizationConflicts }
}
