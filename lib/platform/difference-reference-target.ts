/** The same decision table, with current physical references in target namespaces. */
import { getTableColumns, sql } from 'drizzle-orm'
import { integer, sqliteTable, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import * as s from '../../db/schema'
import { platformBusinessObservation, platformLegacyRelationAlias as r } from './target-schema'
import { sqliteConnection } from './target-connection'
import { requireH1cReady } from './h1c-catalog'
const q = s.platformLegacyQueryAlias
export const targetDifferenceReason = sqliteTable('difference_reason', {
 ...s.differenceReasonFields(),
 evidenceCollectionId: integer('evidence_query_id').references(() => s.platformCollection.id),
 evidenceObservationId: integer('evidence_relation_id').references(() => platformBusinessObservation.id),
 previousId: integer('previous_id').references((): AnySQLiteColumn => targetDifferenceReason.id),
})
/** Public IDs remain external. No row payload, result or permission registration is cached. */
export function differenceEvidenceColumns(db: object) {
 const t = sqliteConnection(db), phase = Number(t.pragma('user_version',{simple:true}))
 if (phase === 71612) {
  requireH1cReady(t)
  return {
   evidenceQueryId: sql<number|null>`(select ${q.oldId} from ${q} where ${q.collectionId} = ${targetDifferenceReason.evidenceCollectionId})`,
   evidenceRelationId: sql<number|null>`(select ${r.oldId} from ${r} where ${r.observationId} = ${targetDifferenceReason.evidenceObservationId})`,
  }
 }
 if (![0,71605,71606,71607,71608,71609,71610,71611].includes(phase)) throw new Error('Unsupported difference reference schema version')
 if (phase === 71611) requireH1cReady(t)
 return {evidenceQueryId:s.differenceReason.evidenceQueryId,evidenceRelationId:s.differenceReason.evidenceRelationId}
}
export function differencePublicColumns(db: object) {
 return {...getTableColumns(s.differenceReason),...differenceEvidenceColumns(db)}
}
