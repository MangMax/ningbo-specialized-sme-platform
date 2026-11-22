import { processFactsFromRow, type PlatformRelationRecord } from './identity'
import type { BusinessStatusValue } from '../../../../db/business-status-contract'
import type { PlatformRow } from './types'

const fields = ['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const
type Field = typeof fields[number]
type TextFacts = Pick<PlatformRelationRecord, Field>
type Facts = Omit<TextFacts, 'status'> & { status: BusinessStatusValue }
export type PlatformNormalizationConflict =
  | { field: 'status'; storedValue: string | Buffer; rawValue: string }
  | { field: Exclude<Field, 'status'>; storedValue: string | number; rawValue: string | number }
/** Check stored comparison values before exposing the field union. */
export function platformNormalizationConflict(field: Field, storedValue: unknown, rawValue: unknown): PlatformNormalizationConflict {
  if (field === 'status') {
    if ((typeof storedValue === 'string' || Buffer.isBuffer(storedValue)) && typeof rawValue === 'string') return { field, storedValue, rawValue }
  } else if ((typeof storedValue === 'string' || typeof storedValue === 'number') && (typeof rawValue === 'string' || typeof rawValue === 'number')) {
    return { field, storedValue, rawValue }
  }
  throw new Error('Invalid platform comparison tuple: ' + field)
}
type ArchivedRelation = Partial<Facts> & { rawFields?: Record<string, unknown> | null }

/** Shared archive/read mapping; identity and raw evidence stay untouched.
 * Conflicting nonempty facts cannot support positive decisions; both values stay explicit.
 * queryBusList remains a recognition snapshot, never a process row.
 */
export function normalizePlatformRelation<T extends ArchivedRelation>(source: 'business_list', relation: T): Omit<T, Field> & Facts & { normalizationConflicts: PlatformNormalizationConflict[] }
export function normalizePlatformRelation<T extends Partial<TextFacts> & { rawFields?: Record<string, unknown> | null }>(source: string, relation: T): Omit<T, Field> & TextFacts & { normalizationConflicts: PlatformNormalizationConflict[] }
export function normalizePlatformRelation<T extends ArchivedRelation>(source: string, relation: T): Omit<T, Field> & Facts & { normalizationConflicts: PlatformNormalizationConflict[] }
export function normalizePlatformRelation<T extends ArchivedRelation>(source: string, relation: T) {
  const parsed = source === 'apply_list' || source === 'business_list'
    ? processFactsFromRow((relation.rawFields ?? {}) as PlatformRow)
    : null
  const normalizationConflicts: PlatformNormalizationConflict[] = []
  const facts = Object.fromEntries(fields.map(field => {
    if (field === 'status') {
      const stored = relation.status
      const existing = typeof stored === 'string' ? stored.trim() || null : stored ?? null
      const raw = parsed?.status ?? null
      if (existing != null && raw != null && existing !== raw) {
        normalizationConflicts.push({ field, storedValue: existing, rawValue: raw })
        return [field, null]
      }
      return [field, existing ?? raw]
    }
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
