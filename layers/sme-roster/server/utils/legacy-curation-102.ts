import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as s from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { patchCuration, type CurationPatch } from '../../lib/curation'
import { DecisionError102, managedDecision102, type DecisionDb } from './decision-lifecycle-102'
import { lockPostgresDecisionOwnership102 } from './decision-lifecycle-102/postgres-writes'

function exactLegacyEnterpriseId(candidates: { id: number }[]) {
  if (candidates.length > 1) {
    throw new DecisionError102(409, 'ambiguous_enterprise', 'Legacy annotation identity matches multiple enterprises; supply an exact USCC')
  }
  return candidates[0]?.id
}

function rejectManagedLegacyAnnotation(): never {
  throw new DecisionError102(409, 'decision_lifecycle_required', 'This coordinate is managed by decision lifecycle commands; legacy annotations cannot overwrite its state')
}

/** Keep legacy annotation semantics until explicit lifecycle adoption of this coordinate. */
export function patchLegacyCuration102(db: DecisionDb, path: string, patch: CurationPatch) {
  // Serialize the ownership check and synchronous file write with lifecycle commands,
  // including writers on other connections. This does not create a formal decision.
  return db.transaction(tx => {
    // Preserve baseline USCC precedence and JSON key spelling; only canonicalize
    // the USCC lookup. Never resolve by aliases, fuzzy names, or name fallback.
    const candidates = tx.select({ id: s.enterprise.id }).from(s.enterprise).where(
      patch.uscc ? eq(s.enterprise.usccNorm, normalizeUscc(patch.uscc)) : eq(s.enterprise.nameNorm, patch.nameNorm!),
    ).limit(2).all()
    const enterpriseId = exactLegacyEnterpriseId(candidates)
    if (enterpriseId != null && tx.select({ id: s.differenceReason.id }).from(s.differenceReason).where(and(
      eq(s.differenceReason.enterpriseId, enterpriseId), eq(s.differenceReason.titleCode, patch.titleCode),
      eq(s.differenceReason.direction, patch.direction), managedDecision102(),
    )).limit(1).get()) rejectManagedLegacyAnnotation()
    // Zero exact matches remain JSON-only annotations, as in the original API.
    patchCuration(path, patch)
    return { curated: patch.curated }
  }, { behavior: 'immediate' })
}

export function patchPostgresLegacyCuration102(db: NodePgDatabase, path: string, patch: CurationPatch) {
  return db.transaction(async tx => {
    await lockPostgresDecisionOwnership102(tx)
    const column = patch.uscc ? sql`uscc_norm` : sql`name_norm`
    const key = patch.uscc ? normalizeUscc(patch.uscc) : patch.nameNorm!
    const candidates = key.includes('\0') || !key.isWellFormed() ? [] : (await tx.execute<{ id: number }>(sql`
      SELECT id::float8 AS id FROM enterprise WHERE ${column}=${key} LIMIT 2`)).rows
    const enterpriseId = exactLegacyEnterpriseId(candidates)
    if (enterpriseId != null) {
      const owned = await tx.execute(sql`SELECT 1 FROM difference_reason d WHERE d.enterprise_id=${enterpriseId}
        AND d.title_code=${patch.titleCode} AND d.direction=${patch.direction}
        AND ${managedDecision102(sql`d.id`, sql`d.lifecycle_action`)} LIMIT 1`)
      if (owned.rows.length) rejectManagedLegacyAnnotation()
    }
    patchCuration(path, patch)
    return { curated: patch.curated }
  }, { isolationLevel: 'read committed' })
}
