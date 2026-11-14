/** Offline only; evidence directory is new and source snapshots remain untouched. */
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { transferDifferenceReferences } from './difference-references'
const [source,target,evidence,runId] = process.argv.slice(2)
if (!source || !target || !evidence || !runId) throw new Error('Usage: FIXED_SOURCE_71611 INDEPENDENT_TARGET NEW_EVIDENCE_DIR RUN_ID')
mkdirSync(evidence)
const emit = (name:string,value:unknown) => writeFileSync(`${evidence}/${name}`,JSON.stringify(value,null,2)+'\n',{flag:'wx'})
function capture(path:string) {
 const t = new Database(path,{readonly:true,fileMustExist:true})
 try {
  const tables = (t.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[])
  return {phase:t.pragma('user_version',{simple:true}),catalog:t.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name='difference_reason' ORDER BY type,name").all(),foreignKeys:tables.map(({name})=>({table:name,keys:t.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name)})),foreignKeyCheck:t.pragma('foreign_key_check'),integrity:t.pragma('integrity_check'),sequence:t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),counts:t.prepare('SELECT count(*) rows,count(evidence_query_id) queries,count(evidence_relation_id) relations FROM difference_reason').get()}
 } finally { t.close() }
}
emit('before.json',{source:capture(source),target:capture(target)})
try {
 const result = transferDifferenceReferences({source,target,runId})
 emit('receipt.json',{...result,target:capture(target)}); process.stdout.write(JSON.stringify(result)+'\n')
} catch (error) {emit('failure.json',{message:error instanceof Error?error.message:String(error),target:capture(target)}); throw error}
