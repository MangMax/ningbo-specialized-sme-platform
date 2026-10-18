import { useDb } from '@db'
import { handlePlatformBatchRequest } from './platform-batch-http'
export function createPlatformBatchRoute(action: 'submit' | 'status' | 'item' | 'retry') {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    const result = await handlePlatformBatchRequest(action, {
      body: action === 'submit' || action === 'retry' ? await readBody(event).catch(() => null) : undefined,
      batchId: getRouterParam(event, 'batchId'), itemId: getRouterParam(event, 'itemId'),
      headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') },
    }, { db: useDb(), apiToken: useRuntimeConfig(event).apiToken, filesDir: useRuntimeConfig(event).filesDir })
    setResponseStatus(event, result.status)
    for (const [name, value] of Object.entries(result.headers)) setHeader(event, name, value)
    return result.body
  })
}
