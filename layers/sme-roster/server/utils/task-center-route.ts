import { sql } from 'drizzle-orm'
import { postgresJobHandler } from '../../../core/server/utils/job-runner-postgres'
import { TASK_EXPORTS } from '../../lib/sme-roster/task-exports'
import type { H3Event } from 'h3'
import type { TaskCenterAction } from '../../../../server/task-center'
import { taskCenterBrowserAccess } from '../../../core/server/utils/task-center-access'
import { requestLogContext } from '../../../core/lib/logging'
import { useDb } from '@db'
import { handleTaskCenterRequest } from './task-center-http'
import { ensureJobRunnerReady } from '../../../core/server/utils/job-runner'
import { registerJobSpecs } from '../../../../server/utils/job-specs'
export function rosterPostgresTaskListOptions(query: Record<string, unknown>) {
  const title = TASK_EXPORTS.find(item => item.titleCode === query.titleCode)
  return {
    filter: title ? sql`kind = 'current-roster-export' AND business.job_params_for_query(params) ->> 'titleCode' = ${title.titleCode}` : undefined,
    exportReady: Boolean(postgresJobHandler('current-roster-export')),
  }
}

export async function handleTaskCenterRoute(action: TaskCenterAction, event: H3Event) {
  registerJobSpecs()
  const db = useDb()
  ensureJobRunnerReady(db)
  const result = await handleTaskCenterRequest(action, {
    method: event.method, path: getRequestURL(event).pathname, query: getQuery(event),
    headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') },
  }, { db, browserAuthorized: taskCenterBrowserAccess(event), apiToken: useRuntimeConfig(event).apiToken, filesDir: useRuntimeConfig(event).filesDir, logContext: requestLogContext(event) })
  setResponseStatus(event, result.status)
  for (const [name, value] of Object.entries(result.headers)) setHeader(event, name, value)
  return result.body
}
