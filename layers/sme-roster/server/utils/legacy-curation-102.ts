import { and, eq, exists, isNotNull, or } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { evidenceReviewReceipt114 as receipt } from '../../../../db/postgresql/evidence-review-tables'
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
    const column = patch.uscc ? enterprise.usccNorm : enterprise.nameNorm
    const key = patch.uscc ? normalizeUscc(patch.uscc) : patch.nameNorm!
    const candidates = key.includes('\0') || !key.isWellFormed() ? [] : await tx
      .select({ id: enterprise.id }).from(enterprise).where(eq(column, key)).limit(2)
    const enterpriseId = exactLegacyEnterpriseId(candidates)
    if (enterpriseId != null) {
      const reviewed = tx.select({ id: receipt.reviewedRevisionId }).from(receipt).where(and(
        isNotNull(receipt.reviewedRevisionId),
        or(eq(receipt.decisionId, differenceReason.id), eq(receipt.sourceDecisionId, differenceReason.id)),
      ))
      const owned = await tx.select({ id: differenceReason.id }).from(differenceReason).where(and(
        eq(differenceReason.enterpriseId, enterpriseId), eq(differenceReason.titleCode, patch.titleCode),
        eq(differenceReason.direction, patch.direction), or(isNotNull(differenceReason.lifecycleAction), exists(reviewed)),
      )).limit(1)
      if (owned.length) rejectManagedLegacyAnnotation()
    }
    patchCuration(path, patch)
    return { curated: patch.curated }
  }, { isolationLevel: 'read committed' })
}
