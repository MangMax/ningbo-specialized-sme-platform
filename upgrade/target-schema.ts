/** T05c offline target only. W/R adopt these shared declarations; Z deletes expand declarations. */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as expand from '../db/schema'
export const platformBusinessObservation = sqliteTable('platform_business_observation', {
  id: integer('id').primaryKey(),
  collectionId: integer('collection_id').notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
  sequenceNo: integer('sequence_no').notNull(),
  ...expand.observationFields(),
  positionState: text('position_state',{enum:['verified','unknown','conflict']}).notNull(),
},t=>expand.observationConstraints(t,t.id))
export const platformObservationAssignment=expand.definePlatformObservationAssignment(()=>platformBusinessObservation.id)
export const platformObservationArchiveRef=expand.definePlatformObservationArchiveRef(()=>platformBusinessObservation.id)
export const platformLegacyRelationAlias=expand.definePlatformLegacyRelationAlias(()=>platformBusinessObservation.id)
export const platformApplyProjection=expand.definePlatformApplyProjection(()=>platformBusinessObservation.id)
export const platformBusinessProjection=expand.definePlatformBusinessProjection(()=>platformBusinessObservation.id)
export const platformRecognizedProjection=expand.definePlatformRecognizedProjection(()=>platformBusinessObservation.id)
export const targetSchema={...expand,platformBusinessObservation,platformObservationAssignment,platformObservationArchiveRef,platformLegacyRelationAlias,platformApplyProjection,platformBusinessProjection,platformRecognizedProjection}
