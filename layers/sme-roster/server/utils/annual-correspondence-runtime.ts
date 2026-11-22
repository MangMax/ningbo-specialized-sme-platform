import { ANNUAL_CORRESPONDENCE_KIND as KIND } from '../../lib/roster/annual-correspondence'
import { isJobId } from '../../../core/lib/job'
import { operationLogContext } from '../../../core/server/utils/operation-log-context'
import { readApiToken, resolveApiAuth } from '../../../core/server/utils/api-auth'
import { cancelPostgresJob, getPostgresJob } from '../../../core/server/utils/job-store-postgres'
import { postgresJobsEnabled } from '../../../core/server/utils/postgres-jobs'
import { annualErrorCode } from './jobs/annual-correspondence-job-contract'
import { getPostgresAnnualTask, retryPostgresAnnualCorrespondence, submitPostgresAnnualCorrespondence } from './jobs/annual-correspondence-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

import type { AnnualTaskAction, AnnualRuntimeContext } from './annual-correspondence-api'

export async function handlePostgresAnnualTaskRequest(action: AnnualTaskAction, req: {method:string;body?:unknown;id?:unknown;headers?:Record<string,string|undefined>}, ctx: AnnualRuntimeContext) {
  const headers = {'cache-control':'no-store'}
  const error = (status:number,code:string) => ({status,headers,body:{error:{code}}})
  if (req.method !== (action === 'detail' ? 'GET' : 'POST')) return error(405,'method_not_allowed')
  const authorized = ctx.browserAuthorized === true || resolveApiAuth({given:readApiToken(req.headers),configured:ctx.apiToken}).writeAuthorized
  if (action !== 'detail' && !authorized) return error(401,'unauthorized')
  try {
    const postgres = usePostgresRosterDb()
    const writable = postgresJobsEnabled()
    if (action !== 'detail' && !writable) return error(403, 'readonly_database')
    if (action === 'submit') {
      const body = await submitPostgresAnnualCorrespondence(postgres, req.body, ctx.filesDir, ctx.logContext)
      return { status: 202, headers: { ...headers, location: `/api/roster/annual-correspondence-tasks/${body.jobId}` }, body }
    }
    if (!isJobId(req.id)) return error(400, 'invalid_task_id')
    if (action === 'detail') {
      const body = await getPostgresAnnualTask(postgres, req.id, authorized && writable)
      return body ? { status: 200, headers, body } : error(404, 'task_not_found')
    }
    if ((await getPostgresJob(postgres, req.id))?.row.kind !== KIND) return error(404, 'task_not_found')
    if (action === 'retry') return { status: 202, headers, body: await retryPostgresAnnualCorrespondence(postgres, req.id, ctx.filesDir) }
    const cancelled = await cancelPostgresJob(postgres, req.id, ctx.logContext)
    if (!cancelled) return error(404, 'task_not_found')
    const { state, note } = cancelled
    const outcome = cancelled.alreadyFinished ? { alreadyFinished: true } : cancelled.cancelRequested ? { cancelRequested: true } : {}
    return { status: 200, headers, body: { jobId: req.id, ok: true, state, cancelled: cancelled.cancelled, ...outcome, note } }
  } catch (cause) {
    const status = (cause as {statusCode?:number}).statusCode
    return error(status && status < 500 ? status : 503,annualErrorCode(cause))
  }
}
/** MCP authorization is provided by the MCP credential boundary, independently
 * of REST/browser credentials. Both dispatch exactly the same business action. */
export async function dispatchPostgresAnnualTaskMcp(action: AnnualTaskAction, args: Record<string,unknown>, ctx: AnnualRuntimeContext & {authorized:boolean}) {
  const output = await handlePostgresAnnualTaskRequest(action,{method:action === 'detail' ? 'GET' : 'POST',body:args,id:args.id},{
    ...ctx, browserAuthorized: ctx.authorized, logContext: ctx.logContext ?? operationLogContext.getStore(),
  })
  return output.status < 300 ? {...output.body} : {isError:true,content:[{type:'text' as const,text:JSON.stringify(output.body)}]}
}
