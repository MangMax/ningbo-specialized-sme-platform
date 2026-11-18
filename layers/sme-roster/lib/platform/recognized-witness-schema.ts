/** Additive explicit successor registry only; ordinary expand declarations stay unchanged. */
import { customType, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { platformArchiveValue } from '../../../../db/schema'
const cell=customType<{data:string|number|Buffer|null;driverData:string|number|Buffer|null}>({dataType:()=> 'blob'})
export const witnessCollection=sqliteTable('platform_collection',{
 id:integer('id').primaryKey(),
 witness_gate:integer('witness_gate'),witness_rule:text('witness_rule'),
 witness_archive_id:integer('witness_archive_id').references(()=>platformArchiveValue.id,{onDelete:'restrict'}),witness_sha256:text('witness_sha256'),
 witness_error_name:text('witness_error_name'),witness_error:text('witness_error'),
 witness_state:text('witness_state').notNull().default('uncaptured'),
})
export const witnessCondition=sqliteTable('platform_collection_condition',{
 collectionId:integer('collection_id').notNull(),name:text('name').notNull(),witness_kind:text('witness_kind'),witness_value:cell('witness_value'),
})
export const witnessObservation=sqliteTable('platform_business_observation',{
 id:integer('id').primaryKey(),
 witness_rule:text('witness_rule'),witness_collection_id:integer('witness_collection_id'),witness_sequence_no:integer('witness_sequence_no'),
 witness_archive_id:integer('witness_archive_id').references(()=>platformArchiveValue.id,{onDelete:'restrict'}),witness_sha256:text('witness_sha256'),
 witness_ordinal:integer('witness_ordinal'),witness_rdjb_kind:text('witness_rdjb_kind'),witness_rdjb_value:cell('witness_rdjb_value'),witness_rdjb_key:text('witness_rdjb_key'),
 witness_page_kind:text('witness_page_kind'),witness_page_value:cell('witness_page_value'),
 witness_error_name:text('witness_error_name'),witness_error:text('witness_error'),witness_state:text('witness_state').notNull().default('uncaptured'),
})
export const witnessDefinitions={
 platform_collection:{witness_gate:'INTEGER',witness_rule:'TEXT',witness_archive_id:'INTEGER REFERENCES platform_archive_value(id) ON DELETE RESTRICT',witness_sha256:'TEXT',witness_error_name:'TEXT',witness_error:'TEXT',witness_state:"TEXT NOT NULL DEFAULT 'uncaptured'"},
 platform_collection_condition:{witness_kind:'TEXT',witness_value:'BLOB'},
 platform_business_observation:{witness_rule:'TEXT',witness_collection_id:'INTEGER',witness_sequence_no:'INTEGER',witness_archive_id:'INTEGER REFERENCES platform_archive_value(id) ON DELETE RESTRICT',witness_sha256:'TEXT',witness_ordinal:'INTEGER',witness_rdjb_kind:'TEXT',witness_rdjb_value:'BLOB',witness_rdjb_key:'TEXT',witness_page_kind:'TEXT',witness_page_value:'BLOB',witness_error_name:'TEXT',witness_error:'TEXT',witness_state:"TEXT NOT NULL DEFAULT 'uncaptured'"},
}
