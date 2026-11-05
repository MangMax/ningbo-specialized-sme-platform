import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { useDb } from '../../db/client'
import { differenceReason } from '../../db/schema'
import { queueInput } from './difference-queue'
const evidence = z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('platform'),itemId:z.string(),segment:z.number().int().min(0),row:z.number().int().min(0)}),
 z.strictObject({kind:z.literal('official'),evidenceId:z.number().int().positive()}),
 z.strictObject({kind:z.literal('external'),url:z.url().refine(v=>['https:','http:'].includes(new URL(v).protocol)),note:z.string().trim().min(1).max(4000)}),
])
export const judgmentValue=z.strictObject({status:z.enum(differenceReason.status.enumValues),reasonCode:z.enum(differenceReason.reasonCode.enumValues).nullable(),measureCode:z.enum(differenceReason.measureCode.enumValues).nullable(),notes:z.string().max(20000),searchedScope:z.string().max(20000),gaps:z.string().max(20000),evidence:z.array(evidence).max(200)})
const coordinate={jobId:queueInput.shape.jobId,enterpriseId:z.number().int().positive(),titleCode:z.enum(['innovative_sme','specialized_sme','little_giant']),direction:z.enum(differenceReason.direction.enumValues)}
export const judgmentInput=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('read'),...coordinate}),
 z.strictObject({action:z.literal('write'),...coordinate,expectedToken:z.number().int().nonnegative(),expected:judgmentValue,current:judgmentValue,actor:z.string().trim().min(1).max(200)}),
])
const fail=(statusCode:number,message:string):never=>{throw Object.assign(new Error(message),{statusCode})}
type Db=ReturnType<typeof useDb>
export async function snapshotJudgment(db:Db,raw:unknown) {
 const parsed=judgmentInput.safeParse(raw);if(!parsed.success) return fail(400,'Invalid judgment input')
 const input=parsed.data, keys=[input.jobId,input.enterpriseId,input.titleCode,input.direction]

 const job=db.$client.prepare('select kind,state,result,params from job where id=?').get(input.jobId) as {kind:string;state:string;result:string;params:string}|undefined
 if(!job||job.kind!=='difference-snapshot') return fail(404,'Snapshot not found')
 if(['running','queued'].includes(job.state)) return fail(409,'Snapshot active')
 const result=JSON.parse(job.result)
 const candidate=result.queue?.rows.find((r:Record<string,unknown>)=>r.enterpriseId===input.enterpriseId&&r.titleCode===input.titleCode&&r.direction===input.direction)
 if(!candidate) return fail(404,'Coordinate not in snapshot')
 const load=()=>{
 const saved=db.$client.prepare('select current from snapshot_judgment where job_id=? and enterprise_id=? and title_code=? and direction=?').get(...keys) as {current:string}|undefined
 let current=saved?JSON.parse(saved.current):{status:candidate.status,reasonCode:candidate.reasonCode,measureCode:null,notes:'',searchedScope:'',gaps:'',evidence:[]}
 const token=(db.$client.prepare('select coalesce(max(id),0) token from snapshot_judgment_operation where job_id=? and enterprise_id=? and title_code=? and direction=?').get(...keys) as {token:number}).token
 return {current,token}
 }
 const scope=result.scope??[]
 const member=scope.find((r:{enterpriseId:number})=>r.enterpriseId===input.enterpriseId)
 const ids=scope.filter((r:{enterpriseId:number;uscc?:string})=>r.enterpriseId===input.enterpriseId||(member?.uscc&&/^[0-9A-Z]{18}$/.test(member.uscc)&&r.uscc===member.uscc)).map((r:{enterpriseId:number})=>r.enterpriseId)
 const platformHistory=(result.items??[]).filter((r:{enterpriseId:number})=>ids.includes(r.enterpriseId))
 const backup=JSON.parse(job.params).backup
 let officialSources:unknown[]=[]
 if(backup) {
 // Pin an open file descriptor throughout verification and SQLite reads. No path cache.
 let file
 try {file=await open(backup.path,'r')} catch {return fail(409,'Backup unavailable')}
 try {
 const before=await file.stat({bigint:true})
 const hash=createHash('sha256')
 for await (const chunk of file.createReadStream({autoClose:false})) hash.update(chunk)
 if(hash.digest('hex')!==backup.sha256) return fail(409,'Backup checksum mismatch')
 const identity=(v:typeof before)=>[v.dev,v.ino,v.size,v.mtimeNs,v.ctimeNs].join(':')
 const frozen=new Database(backup.path,{readonly:true,fileMustExist:true})
 try {
 const pathFile=await open(backup.path,'r')
 try {if(identity(await pathFile.stat({bigint:true}))!==identity(before)) return fail(409,'Backup changed')} finally {await pathFile.close()}
 officialSources=ids.flatMap((id:number)=>frozen.prepare(`select r.*,e.id event_id,e.event_type,e.year,e.batch_seq,e.decided_year,e.review_outcome,e.formal_validity,v.id evidence_id,v.source_file,v.attachment,v.list_no,v.page from record r left join record_event e on e.record_id=r.id left join record_evidence v on v.record_event_id=e.id where r.enterprise_id=? and r.source='jxj' order by r.id,e.id,v.id`).all(id))
 const finalPath=await open(backup.path,'r')
 try {if(identity(await finalPath.stat({bigint:true}))!==identity(before)) return fail(409,'Backup changed')} finally {await finalPath.close()}
 if(identity(await file.stat({bigint:true}))!==identity(before)) return fail(409,'Backup changed')
 } finally {frozen.close()}
 } finally {await file.close()}
 }
 const finish=()=>{
 // Recheck the task and CAS after asynchronous evidence preparation, inside the brief write transaction.
 const latest=db.$client.prepare('select state,result,params from job where id=?').get(input.jobId) as {state:string;result:string;params:string}|undefined
 if(!latest||['running','queued'].includes(latest.state)||latest.result!==job.result||latest.params!==job.params) return fail(409,'Snapshot changed; read again')
 let {current,token}=load()
 if(input.action==='write') {
 const value=input.current
 if(token!==input.expectedToken||!isDeepStrictEqual(current,input.expected)) return fail(409,'Current judgment changed; read before overwriting')
 if(value.status==='confirmed_reason'&&!value.reasonCode) return fail(400,'Confirmed reason required')
 if(value.status!=='confirmed_reason'&&value.reasonCode!==null) return fail(400,'Reason belongs to confirmed_reason only')
 if(!['confirmed_no_diff','confirmed_reason'].includes(value.status)&&(!value.searchedScope.trim()||!value.gaps.trim())) return fail(400,'Unresolved judgment requires searched scope and gaps')
 if(!value.notes.trim()) return fail(400,'Judgment notes required')
 for(const ref of value.evidence) {
 if(ref.kind==='platform') {const item=platformHistory.find((r:{itemId:string})=>r.itemId===ref.itemId);if(!item?.segments?.[ref.segment]?.rows?.[ref.row]) return fail(400,'Platform reference outside coordinate history')}
 if(ref.kind==='official'&&!officialSources.some(r=>(r as {evidence_id:number}).evidence_id===ref.evidenceId)) return fail(400,'Official reference outside snapshot scope')
 }
 if(!isDeepStrictEqual(current,value)) {
 db.$client.prepare('insert into snapshot_judgment values (?,?,?,?,?) on conflict(job_id,enterprise_id,title_code,direction) do update set current=excluded.current').run(...keys,JSON.stringify(value))
 db.$client.prepare('insert into snapshot_judgment_operation(job_id,enterprise_id,title_code,direction,actor,before_value,after_value,recorded_at) values(?,?,?,?,?,?,?,?)').run(...keys,input.actor,JSON.stringify(current),JSON.stringify(value),new Date().toISOString())
 current=value
 token=load().token
 }
 }
 const operations=db.$client.prepare('select id,actor,before_value,after_value,recorded_at from snapshot_judgment_operation where job_id=? and enterprise_id=? and title_code=? and direction=? order by id').all(...keys).map(r=>{const row=r as {id:number;actor:string;before_value:string;after_value:string;recorded_at:string};return {id:row.id,actor:row.actor,before:JSON.parse(row.before_value),after:JSON.parse(row.after_value),recordedAt:row.recorded_at}})
 return {jobId:input.jobId,enterpriseId:input.enterpriseId,titleCode:input.titleCode,direction:input.direction,current,token,operations,platformHistory,officialSources,officialScope:scope,skillReference:'.agents/skills/roster-ingestion-pipeline/references/difference-investigation.md'}
 }
 return input.action==='write'?db.$client.transaction(finish).immediate():db.$client.transaction(finish).deferred()
}
