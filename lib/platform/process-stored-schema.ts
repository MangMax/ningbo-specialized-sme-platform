/** Explicit 71610 only. Never registered with expand/startup migrations. */
import { customType, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { businessProjectionFields } from '../../db/schema'
import { platformBusinessObservation, targetSchema } from './target-schema'
const cellText=customType<{data:unknown,driverData:unknown}>({dataType:()=> 'text'})
const cellInteger=customType<{data:unknown,driverData:unknown}>({dataType:()=> 'integer'})
export function processStoredFields(){return {
 exactStatus:cellText('exact_status'),exactDeclareKind:cellText('exact_declare_kind'),exactAppliedAt:cellText('exact_applied_at'),
 exactYear:cellInteger('exact_year'),exactTitleRaw:cellText('exact_title_raw'),exactBatch:cellText('exact_batch'),
 exactAwardBatchLabel:cellText('exact_award_batch_label'),exactProvince:cellText('exact_province'),
 exactStoredState:text('exact_stored_state',{enum:['captured','uncaptured']}),exactStoredRule:text('exact_stored_rule'),
 exactStoredOrigin:text('exact_stored_origin',{enum:['legacy_source','sealed_snapshot','command_materialized']}),exactStoredReason:text('exact_stored_reason'),
 sqlFactTitle:text('sql_fact_title'),sqlFactTitleState:text('sql_fact_title_state',{enum:['captured','uncaptured']}),
 sqlFactTitleRule:text('sql_fact_title_rule'),sqlFactTitleReason:text('sql_fact_title_reason'),
}}
export const storedProcessProjection=sqliteTable('platform_business_projection',{
 ...businessProjectionFields(()=>platformBusinessObservation.id),...processStoredFields(),
})
/** Internal pairing references; physical deferred FK is installed offline. */
export const processStoredObservation=sqliteTable('platform_business_observation',{
 id:integer('id').primaryKey(),processExactOwnerId:integer('process_exact_owner_id'),
 processExactState:text('process_exact_state',{enum:['captured','uncaptured']}),
 processSqlFactTitleState:text('process_sql_fact_title_state',{enum:['captured','uncaptured']}),
})
export const processStoredSchema={...targetSchema,platformBusinessProjection:storedProcessProjection,processStoredObservation}
