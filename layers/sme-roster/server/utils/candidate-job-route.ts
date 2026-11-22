import { requestLogContext } from '../../../core/lib/logging'
import { taskCenterBrowserAccess } from '../../../core/server/utils/task-center-access'
import { handlePostgresCandidateJobRequest } from './candidate-job-runtime'
import type { CandidateJobAction } from './candidate-job-api'
export function candidateJobRoute(action: CandidateJobAction) {
  return defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    try {
      if (event.method === 'POST') body = await readBody(event)
    } catch {
      throw createError({ statusCode: 400, message: '无效 JSON 请求' })
    }
    const config = useRuntimeConfig(event)
    const result = await handlePostgresCandidateJobRequest(
      action,
      {
        method: event.method,
        path: getRequestURL(event).pathname,
        id: getRouterParam(event, 'id'),
        body,
        headers: {
          authorization: getHeader(event, 'authorization'),
          'x-api-token': getHeader(event, 'x-api-token'),
        },
      },
      {

        filesDir: config.filesDir,
        apiToken: config.apiToken,
        browserAuthorized: taskCenterBrowserAccess(event),
        logContext: requestLogContext(event),
      },
    )
    setResponseStatus(event, result.status)
    for (const [name, value] of Object.entries(result.headers))
      setHeader(event, name, value)
    return result.body
  })
}
