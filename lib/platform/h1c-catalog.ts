/** Internal target migration readiness; comprehensive validation belongs offline. */
import type Database from 'better-sqlite3'
export const H1C_CATALOG_VERSION = 71611
export const H1C_CATALOG_TRANSFORM = 'h1c-correspondence-observation-v1'
export function hasColumns(t:Database.Database,table:string,names:readonly string[]) {
 const columns=t.prepare('SELECT name FROM pragma_table_info(?)').all(table) as {name:string}[]
 return names.every(name=>columns.some(column=>column.name===name))
}
/** Migration logs provide a completion flag, not a query-time authentication chain. */
export function migrationFinished(t:Database.Database,transform:string) {
 if(!hasColumns(t,'platform_migration_run',['state','transform_version']))return false
 return !!t.prepare("SELECT 1 FROM platform_migration_run WHERE transform_version=? AND state='complete' LIMIT 1").get(transform)
}
export function requireH1cReady(t:Database.Database) {
 if(t.pragma('user_version',{simple:true})!==H1C_CATALOG_VERSION)throw new Error('Unsupported H1c schema version')
 if(!hasColumns(t,'record_correspondence',['id','observation_id'])||!hasColumns(t,'platform_business_observation',['id','collection_id'])||!migrationFinished(t,H1C_CATALOG_TRANSFORM))throw new Error('H1c migration incomplete; finish the offline migration before using this target')
}
