import { sql } from 'drizzle-orm'
/** Explicit finalized-target declarations. Not registered in ordinary expand schema; W/R adoption is gated. */
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as expand from '../../db/schema'
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

/** #720 successor only: same physical tables, collection ownership. */
export const platformQueryTitleScope = sqliteTable('platform_query_title_scope', {
  collectionId: integer('collection_id').notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
  rdjb: text('rdjb').notNull(),
}, t=>[
  primaryKey({columns:[t.collectionId,t.rdjb]}),
  index('platform_query_title_scope_rdjb_collection_idx').on(t.rdjb,t.collectionId),
  check('platform_query_title_scope_safe_id',sql`${t.collectionId} > 0 AND ${t.collectionId} <= 9007199254740991`),
])
export const platformQueryTitleScopeError = sqliteTable('platform_query_title_scope_error', {
  collectionId: integer('collection_id').primaryKey().notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
}, t=>[check('platform_query_title_scope_error_safe_id',sql`${t.collectionId} > 0 AND ${t.collectionId} <= 9007199254740991`)])

export const targetSchema={...expand,platformBusinessObservation,platformObservationAssignment,platformObservationArchiveRef,platformLegacyRelationAlias,platformApplyProjection,platformBusinessProjection,platformRecognizedProjection,platformQueryTitleScope,platformQueryTitleScopeError}
