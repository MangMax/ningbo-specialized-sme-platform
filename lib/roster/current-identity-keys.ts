import type Database from 'better-sqlite3'
import { normalizeUscc } from '../domain'
import { and, eq, isNull, max, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema } from '../platform/target-schema'

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

/** Completed-target request scope. Only current unassigned revisions contribute
 * relation keys; collection keys retain their original spelling and name keys.
 * Drizzle builds these narrow DISTINCT projections; the driver streams them. */
export function readTargetIdentityKeyVariants(db: Database.Database, source: 'queries' | 'unassignedRelations'): IdentityKeyVariants {
  const reader = drizzle(db, { schema: targetSchema })
  const { platformCollection: collection, platformObservationAssignment: assignment } = targetSchema
  const newer = alias(assignment, 'identity_newer_assignment')
  const query = (source === 'queries'
    ? reader.selectDistinct({ key: sql<string>`${collection.queryKey}`.as('key') }).from(collection)
    : reader.selectDistinct({ key: sql<string | null>`${assignment.usccRaw}`.as('key') }).from(assignment).where(and(
      isNull(assignment.enterpriseId),
      eq(assignment.revision, reader.select({ revision: max(newer.revision) }).from(newer)
        .where(eq(newer.observationId, assignment.observationId))),
    ))).toSQL()
  const variants = new Map<string, string[]>()
  for (const { key } of db.prepare(query.sql).iterate(...query.params) as Iterable<{ key: string | null }>) {
    const normalized = normalizeUscc(key)
    if (key === null || !normalized || normalized === key) continue
    const keys = variants.get(normalized) ?? []
    keys.push(key)
    variants.set(normalized, keys)
  }
  return variants
}
