/** The same decision table, with current physical references in target namespaces. */
import { getTableColumns,sql } from 'drizzle-orm'
import * as s from '../../db/schema'
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
export function differencePublicColumns(db: object) {
 const { evidenceCollectionId: _collection, evidenceObservationId: _observation, ...columns } = getTableColumns(s.differenceReason)
 return {...columns,...differenceEvidenceColumns(db)}
}
