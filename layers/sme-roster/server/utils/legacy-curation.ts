import { isManagedDifference } from './decision-lifecycle/reviewed-decisions'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { normalizeUscc } from '../../lib/domain'
import { patchCuration, type CurationPatch } from '../../lib/curation-model'
import { DecisionError102 } from './decision-lifecycle/contract'
import { lockPostgresDecisionOwnership102 } from './decision-lifecycle/postgres-writes'

function exactLegacyEnterpriseId(candidates: { id: number }[]) {
  if (candidates.length > 1) {
    throw new DecisionError102(409, 'ambiguous_enterprise', 'Legacy annotation identity matches multiple enterprises; supply an exact USCC')
  }
  return candidates[0]?.id
}

function rejectManagedLegacyAnnotation(): never {
  throw new DecisionError102(409, 'decision_lifecycle_required', 'This coordinate is managed by decision lifecycle commands; legacy annotations cannot overwrite its state')
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
      const owned = await tx.select({ id: differenceReason.id }).from(differenceReason).where(and(
        eq(differenceReason.enterpriseId, enterpriseId), eq(differenceReason.titleCode, patch.titleCode),
        eq(differenceReason.direction, patch.direction), isManagedDifference(),
      )).limit(1)
      if (owned.length) rejectManagedLegacyAnnotation()
    }
    patchCuration(path, patch)
    return { curated: patch.curated }
  }, { isolationLevel: 'read committed' })
}
