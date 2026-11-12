/** Completion flags and necessary columns only; full validation is offline. */
import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished } from './migration-readiness'
export const DIFFERENCE_REFERENCE_VERSION = 71612
export const DIFFERENCE_REFERENCE_TRANSFORM = 'difference-evidence-reference-v1'
export function requireDifferenceReferencesReady(t: Database.Database) {
 if (t.pragma('user_version',{simple:true}) !== DIFFERENCE_REFERENCE_VERSION) throw new Error('Unsupported difference reference schema version')
 if (!hasColumns(t,'difference_reason',['id','evidence_query_id','evidence_relation_id','previous_id']) || !hasColumns(t,'platform_collection',['id']) || !hasColumns(t,'platform_business_observation',['id','collection_id']) || !hasColumns(t,'platform_legacy_query_alias',['old_id','collection_id']) || !hasColumns(t,'platform_legacy_relation_alias',['old_id','observation_id']) || !migrationFinished(t,DIFFERENCE_REFERENCE_TRANSFORM)) throw new Error('Difference reference migration incomplete; finish offline migration before using this target')
}
