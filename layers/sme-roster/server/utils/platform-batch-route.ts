import { handlePlatformBatchRequest } from './platform-batch-http'
import { requestLogContext } from '../../../core/lib/logging'
export function createPlatformBatchRoute(action: 'submit' | 'status' | 'item' | 'retry') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    const { apiToken, filesDir } = useRuntimeConfig()
    const result = await handlePlatformBatchRequest(action, {
      body: action === 'submit' || action === 'retry' ? await readBody(event).catch(() => null) : undefined,
      batchId: getRouterParam(event, 'batchId'), itemId: getRouterParam(event, 'itemId'),
      headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') },
    }, { apiToken, filesDir, logContext: requestLogContext(event) })
    setResponseStatus(event, result.status)
    for (const [name, value] of Object.entries(result.headers)) setHeader(event, name, value)
    return result.body
  })
}
