import { getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus, type H3Event } from 'h3'
import { useDb } from '@db'
import { handleRecordCorrespondenceRequest, type CorrespondenceAction } from './record-correspondence-api'
export function correspondenceRoute(action: CorrespondenceAction, options: { id?: boolean; kind?: 'event' | 'relation' | 'export_row'; key?: boolean } = {}) {
  return defineEventHandler(async (event: H3Event) => {
    setHeader(event, 'cache-control', 'no-store')
    const output = handleRecordCorrespondenceRequest({ action, method: getMethod(event), query: getQuery(event), body: ['POST', 'PUT', 'PATCH'].includes(getMethod(event)) ? await readBody(event) : undefined, id: options.id ? getRouterParam(event, 'id') : undefined, kind: options.kind, key: options.key ? getRouterParam(event, 'idempotencyKey') : undefined, headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') } }, { db: useDb(), apiToken: useRuntimeConfig().apiToken })
    setResponseStatus(event, output.status)
    for (const [name, value] of Object.entries(output.headers)) setHeader(event, name, value)
    return output.body
  })
}
