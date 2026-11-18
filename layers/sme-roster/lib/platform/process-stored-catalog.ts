import { isFinalPlatformRuntimeVersion } from '../../../../db/schema-phase'
/** Runtime readiness only; FK/catalog/data validation runs at offline completion. */
import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished, requireH1cReady } from './h1c-catalog'
export const PROCESS_STORED_TRANSFORM='process-exact-stored-offline-v1'
export function processStoredInstalled(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(!isFinalPlatformRuntimeVersion(phase))throw new Error('Final native platform schema required')
 requireH1cReady(t)
 if(!hasColumns(t,'platform_business_projection',['observation_id','exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','exact_batch','exact_award_batch_label','exact_province','exact_stored_state','exact_stored_rule','exact_stored_origin','exact_stored_reason','sql_fact_title','sql_fact_title_state','sql_fact_title_rule','sql_fact_title_reason'])||!hasColumns(t,'platform_business_observation',['process_exact_owner_id','process_exact_state','process_sql_fact_title_state'])||!migrationFinished(t,PROCESS_STORED_TRANSFORM))throw new Error('Process migration incomplete; finish stored process migration before use')
 return true
}
export function ensureProcessStoredReady(t:Database.Database) {
 processStoredInstalled(t)
}
