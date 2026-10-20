import type { DecisionDb } from '../../server/utils/decision-lifecycle-102'
import { saveDecision102 } from '../../server/utils/decision-lifecycle-102'
import { readEvidenceToken113 } from '../../server/utils/evidence-impact-113'
import type { schema } from '../../db/client'
/** Synthetic subject facts must include #108 review, just like public writes.
 * Evidence-linked and legacy fixtures deliberately remain unreviewed unless the test reviews them.
 */
export function reviewCurrentExportDecision(db: DecisionDb, decision: typeof schema.differenceReason.$inferSelect) {
  if (decision.lifecycleAction !== 'replace' || !decision.basis || !decision.effectiveAt || decision.evidenceQueryId || decision.evidenceRelationId) return
  const scope={enterpriseId:decision.enterpriseId,titleCode:decision.titleCode as 'little_giant'|'specialized_sme'|'innovative_sme',direction:decision.direction as 'extra_in_miit'|'missing_in_miit'}
  const token=readEvidenceToken113(db,scope)
  saveDecision102(db,{...scope,action:'maintain',expectedCurrentId:decision.id,idempotencyKey:'fixture-reviewed-'+decision.id,actor:{type:'agent',id:'synthetic-export'},basis:decision.basis,ruleVersion:'synthetic-export',effectiveAt:decision.effectiveAt,reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
}
