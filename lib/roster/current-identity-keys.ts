import type Database from 'better-sqlite3'
import { normalizeUscc } from '../domain'

export type IdentityKeyVariants = ReadonlyMap<string, readonly string[]>
/** Execution-local, narrow identity keys only. Canonical keys need no entry.
 * Iterate existing covering indexes once per pinned export, not once per row.
 * No business writes, source bodies, persistent cache or truncation.
 */
export function readIdentityKeyVariants(db: Database.Database, source: 'queries' | 'unassignedRelations'): IdentityKeyVariants {
  const variants = new Map<string, string[]>()
  const query = source === 'queries'
    ? 'select distinct query_key as key from platform_query indexed by platform_query_key_idx'
    : 'select distinct uscc_raw as key from platform_relation where enterprise_id is null and uscc_raw is not null'
  for (const { key } of db.prepare(query).iterate() as Iterable<{ key: string }>) {
    const normalized = normalizeUscc(key)
    if (!normalized || normalized === key) continue
    const keys = variants.get(normalized) ?? []
    keys.push(key); variants.set(normalized, keys)
  }
  return variants
}
export function identityKeys(variants: IdentityKeyVariants, uscc: string | null): string[] {
  const normalized = normalizeUscc(uscc)
  return normalized ? [normalized, ...variants.get(normalized) ?? []] : []
}
