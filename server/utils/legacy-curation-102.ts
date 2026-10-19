import { and, eq, sql } from 'drizzle-orm'
import * as s from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { patchCuration, type CurationPatch } from '../../lib/curation'
import { DecisionError102, type DecisionDb } from './decision-lifecycle-102'

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
    if (candidates.length > 1) throw new DecisionError102(409, 'ambiguous_enterprise', 'Legacy annotation identity matches multiple enterprises; supply an exact USCC')
    const enterpriseId = candidates[0]?.id
    if (enterpriseId != null && tx.select({ id: s.differenceReason.id }).from(s.differenceReason).where(and(
      eq(s.differenceReason.enterpriseId, enterpriseId), eq(s.differenceReason.titleCode, patch.titleCode),
      eq(s.differenceReason.direction, patch.direction), sql`${s.differenceReason.lifecycleAction} is not null`,
    )).limit(1).get()) throw new DecisionError102(409, 'decision_lifecycle_required', 'This coordinate is managed by decision lifecycle commands; legacy annotations cannot overwrite its state')
    // Zero exact matches remain JSON-only annotations, as in the original API.
    patchCuration(path, patch)
    return { curated: patch.curated }
  }, { behavior: 'immediate' })
}
