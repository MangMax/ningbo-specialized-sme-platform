/** Offline-only frozen stage dependency from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
/** Explicit 71608 column registry. Never register these columns with the 71607 verifier
 * or ordinary expand schema. SQLite cells intentionally have unknown driver values. */
import { customType, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { platformBusinessObservation } from '../target-schema'
import * as expand from '../legacy-schema'
const exactText=customType<{data:unknown,driverData:unknown}>({dataType:()=> 'text'})
const exactInteger=customType<{data:unknown,driverData:unknown}>({dataType:()=> 'integer'})
export const platformApplyStoredProjection=sqliteTable('platform_apply_projection',{
 id:integer('id').primaryKey(),
 observationId:integer('observation_id').references(()=>platformBusinessObservation.id,{onDelete:'restrict'}),
 ...applyStoredFields(),
},t=>[unique('platform_apply_stored_pair_uq').on(t.observationId,t.exactStoredState,t.sqlFactTitleState)])
/** Pair references are schema-internal. Physical deferred FK lives in offline DDL. */
export const platformApplyStoredObservation=sqliteTable('platform_business_observation',{
 id:integer('id').primaryKey(),
 collectionId:integer('collection_id').notNull(),
 sequenceNo:integer('sequence_no').notNull(),
 ...expand.observationFields(),
 positionState:text('position_state',{enum:['verified','unknown','conflict']}).notNull(),
 applyExactOwnerId:integer('apply_exact_owner_id'),
 applyExactState:text('apply_exact_state',{enum:['captured','uncaptured']}),
 applySqlFactTitleState:text('apply_sql_fact_title_state',{enum:['captured','uncaptured']}),
})
export const applyStoredSchema={platformApplyStoredProjection,platformApplyStoredObservation}

export function applyStoredFields(){return {
 exactStatus:exactText('exact_status'),exactDeclareKind:exactText('exact_declare_kind'),
 exactAppliedAt:exactText('exact_applied_at'),exactYear:exactInteger('exact_year'),exactTitleRaw:exactText('exact_title_raw'),
 exactStoredState:text('exact_stored_state',{enum:['captured','uncaptured']}),exactStoredRule:text('exact_stored_rule'),
 exactStoredOrigin:text('exact_stored_origin',{enum:['legacy_source','sealed_snapshot','command_materialized']}),exactStoredReason:text('exact_stored_reason'),
 sqlFactTitle:text('sql_fact_title'),sqlFactTitleState:text('sql_fact_title_state',{enum:['captured','uncaptured']}),
 sqlFactTitleRule:text('sql_fact_title_rule'),sqlFactTitleReason:text('sql_fact_title_reason'),
}}
export const storedApplyProjection=sqliteTable('platform_apply_projection',{...expand.applyProjectionFields(()=>platformBusinessObservation.id),...applyStoredFields()})
