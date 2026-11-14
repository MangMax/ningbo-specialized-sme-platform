/** Offline only: preserve earlier evidence and all business source files. */
import Database from 'better-sqlite3'
import {mkdirSync,writeFileSync} from 'node:fs'
import {transferCorrespondence} from './correspondence'
const [source,target,evidence,runId]=process.argv.slice(2)
if(!source||!target||!evidence||!runId)throw new Error('Usage: FIXED_SOURCE_71610 INDEPENDENT_TARGET EVIDENCE RUN_ID')
mkdirSync(evidence)
const emit=(file:string,value:unknown)=>writeFileSync(`${evidence}/${file}`,JSON.stringify(value,null,2)+'\n',{flag:'wx'})
function capture(path:string) {
 const t=new Database(path,{readonly:true,fileMustExist:true})
 try {
  return {phase:t.pragma('user_version',{simple:true}),catalog:t.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('record_correspondence','record_correspondence_audit') ORDER BY type,name").all(),foreignKeys:['record_correspondence','record_correspondence_audit'].map(table=>({table,keys:t.pragma(`foreign_key_list(${table})`)})),foreignKeyCheck:t.pragma('foreign_key_check'),counts:t.prepare('SELECT (SELECT count(*) FROM record_correspondence) correspondence,(SELECT count(*) FROM record_correspondence_audit) audit').get()}
 }finally{t.close()}
}
emit('before.json',{source: capture(source),target:capture(target)})
try {
 const result=transferCorrespondence({source,target,runId})
 emit('receipt.json',{...result,target:capture(target)});process.stdout.write(JSON.stringify(result)+'\n')
}catch(error){emit('failure.json',{message:error instanceof Error?error.message:String(error),target:capture(target)});throw error}
