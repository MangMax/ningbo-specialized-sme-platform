import { taskCenterBrowserAccess } from './task-center-access'
import { requestLogContext } from '../../lib/logging'
import { useDb } from '@db'
import { handleTaskCenterRequest } from './task-center-http'
import { ensureJobRunnerReady } from './job-runner'
import { registerJobSpecs } from './job-specs'
/** Thin Nitro binding; HTTP fixtures exercise the same core. */
export function createTaskCenterRoute(action: 'list' | 'detail' | 'cancel' | 'retry') {
  return defineEventHandler(async event => {
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
  })
}
