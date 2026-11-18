/** The same decision table, with current physical references in target namespaces. */
import { getTableColumns,sql } from 'drizzle-orm'
import * as s from '../../../../db/schema'
import { platformLegacyRelationAlias as r } from './target-schema'
const q = s.platformLegacyQueryAlias
export const targetDifferenceReason = s.differenceReason
/** Public IDs remain external aliases; storage always uses native references. */
export function differenceEvidenceColumns(_db: object, owner?: 'd') {
 return {
  evidenceQueryId: sql<number|null>`(select ${q.oldId} from ${q} where ${q.collectionId} = ${owner ? sql`${sql.identifier(owner)}.${sql.identifier('evidence_query_id')}` : targetDifferenceReason.evidenceCollectionId})`,
  evidenceRelationId: sql<number|null>`(select ${r.oldId} from ${r} where ${r.observationId} = ${owner ? sql`${sql.identifier(owner)}.${sql.identifier('evidence_relation_id')}` : targetDifferenceReason.evidenceObservationId})`,
 }
}
/** Field order is part of persisted qualification assessment hashes. */
export function differencePublicColumns(db: object) {
 const c = getTableColumns(s.differenceReason)
 return {
  id:c.id,enterpriseId:c.enterpriseId,titleCode:c.titleCode,direction:c.direction,
  status:c.status,reasonCode:c.reasonCode,reasonNote:c.reasonNote,measureCode:c.measureCode,measureNote:c.measureNote,
  ...differenceEvidenceColumns(db),
  movedInCity:c.movedInCity,movedInTitleCode:c.movedInTitleCode,movedInYear:c.movedInYear,movedInBatch:c.movedInBatch,
  factReferences:c.factReferences,currentQualification:c.currentQualification,verificationStatus:c.verificationStatus,
  recordedAt:c.recordedAt,lifecycleAction:c.lifecycleAction,previousId:c.previousId,
  actor:c.actor,basis:c.basis,ruleVersion:c.ruleVersion,effectiveAt:c.effectiveAt,
  idempotencyKey:c.idempotencyKey,requestHash:c.requestHash,createdAt:c.createdAt,
 }
}
