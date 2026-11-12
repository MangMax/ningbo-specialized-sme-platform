/** Small explicit-target completion checks, shared without catalog predecessor traversal. */
import type Database from 'better-sqlite3'
export function hasColumns(t:Database.Database,table:string,names:readonly string[]) {
 const columns=t.prepare('SELECT name FROM pragma_table_info(?)').all(table) as {name:string}[]
 return names.every(name=>columns.some(column=>column.name===name))
}
/** Migration logs provide a completion flag, not a query-time authentication chain. */
export function migrationFinished(t:Database.Database,transform:string) {
 if(!hasColumns(t,'platform_migration_run',['state','transform_version']))return false
 return !!t.prepare("SELECT 1 FROM platform_migration_run WHERE transform_version=? AND state='complete' LIMIT 1").get(transform)
}
