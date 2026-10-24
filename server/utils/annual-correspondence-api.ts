import { ANNUAL_CORRESPONDENCE_KIND as KIND, ANNUAL_CORRESPONDENCE_VERSION as VERSION, type AnnualTaskDto, type AnnualTaskResult } from '../../lib/roster/annual-correspondence'
import { isJobId } from '../../lib/job'
import type { LogContext } from '../../lib/logging'
import { operationLogContext } from './operation-log-context'
import { annualDbReadonly, annualFail, qualifyAnnualFinal, type AnnualDb, type AnnualScopeReader } from './annual-correspondence'
import { readApiToken, resolveApiAuth } from './api-auth'
import { getJob } from './job-store'
import { requestJobCancel } from './job-runner'
import { annualErrorCode, retryAnnualCorrespondence, submitAnnualCorrespondence } from './jobs/annual-correspondence'
export type AnnualTaskAction = 'submit' | 'detail' | 'cancel' | 'retry'
export interface AnnualTaskContext { db: AnnualDb; readScope: AnnualScopeReader; filesDir: string; apiToken?: string | null; browserAuthorized?: boolean; logContext?: LogContext }
export function readAnnualTask(db: AnnualDb, read: AnnualScopeReader, id: string, authorized: boolean): AnnualTaskDto | null {
  return db.transaction(() => {
    const writable = authorized && !annualDbReadonly(db)
    const row = getJob(db,id)
    if (!row || row.kind !== KIND) return null
    const result = row.result as AnnualTaskResult | null
    let generationCurrent = true
    if (result) for (const event of result.events) {
      const scope = read(db,event.eventId)
      if ((scope?.generation ?? 'event_unavailable') !== event.generation) generationCurrent = false
      event.finalQualification = scope ? qualifyAnnualFinal(db,scope,event.generation) : {stepId:null,status:'blocked',decisionRefs:[],reasons:['event_unavailable']}
    }
    return {jobId:id,kind:KIND,status:row.state,progress:row.progress,result,errorCode:row.state !== 'cancelled' && row.error ? row.error === 'annual_event_failed' ? 'annual_event_failed' : 'annual_task_interrupted' : null,
      capabilities:{cancel:writable && ['queued','running'].includes(row.state),retry:writable && ['failed','cancelled'].includes(row.state) && !!result && result.attempt < 10 && result.ruleVersion === VERSION && generationCurrent}}
  })
}
export async function handleAnnualTaskRequest(action: AnnualTaskAction, req: {method:string;body?:unknown;id?:unknown;headers?:Record<string,string|undefined>}, ctx: AnnualTaskContext) {
  const headers = {'cache-control':'no-store'}
  const error = (status:number,code:string) => ({status,headers,body:{error:{code}}})
  if (req.method !== (action === 'detail' ? 'GET' : 'POST')) return error(405,'method_not_allowed')
  const authorized = ctx.browserAuthorized === true || resolveApiAuth({given:readApiToken(req.headers),configured:ctx.apiToken}).writeAuthorized
  if (action !== 'detail' && !authorized) return error(401,'unauthorized')
  try {
    if (action !== 'detail' && annualDbReadonly(ctx.db)) return error(403,'readonly_database')
    if (action === 'submit') {
      const body = submitAnnualCorrespondence(ctx.db,ctx.readScope,req.body,ctx.filesDir,ctx.logContext)
      return {status:202,headers:{...headers,location:`/api/roster/annual-correspondence-tasks/${body.jobId}`},body}
    }
    if (!isJobId(req.id)) return error(400,'invalid_task_id')
    const task = readAnnualTask(ctx.db,ctx.readScope,req.id,authorized)
    if (!task) return error(404,'task_not_found')
    if (action === 'detail') return {status:200,headers,body:task}
    if (action === 'retry') return {status:202,headers,body:retryAnnualCorrespondence(ctx.db,ctx.readScope,req.id,ctx.filesDir,ctx.logContext)}
    const cancelled = requestJobCancel(ctx.db,req.id,ctx.logContext)
    if (!cancelled.ok) annualFail('task_not_found',404)
    return {status:200,headers,body:{jobId:req.id,...cancelled}}
  } catch (cause) {
    const status = (cause as {statusCode?:number}).statusCode
    return error(status && status < 500 ? status : 503,annualErrorCode(cause))
  }
}
/** MCP authorization is provided by the MCP credential boundary, independently
 * of REST/browser credentials. Both dispatch exactly the same business action. */
export async function dispatchAnnualTaskMcp(action: AnnualTaskAction, args: Record<string,unknown>, ctx: Omit<AnnualTaskContext,'apiToken'|'browserAuthorized'> & {authorized:boolean}) {
  const output = await handleAnnualTaskRequest(action,{method:action === 'detail' ? 'GET' : 'POST',body:args,id:args.id},{
    get db() { return ctx.db }, readScope: ctx.readScope, filesDir: ctx.filesDir, browserAuthorized: ctx.authorized, logContext: ctx.logContext ?? operationLogContext.getStore(),
  })
  return output.status < 300 ? {...output.body} : {isError:true,content:[{type:'text' as const,text:JSON.stringify(output.body)}]}
}
