import { defineEventHandler, getHeader, getMethod, getQuery, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { useDb } from '@db'
import { handleEventCorrectionRequest, type EventCorrectionAction } from './roster-event-correction-api'
export function eventCorrectionRoute(action: EventCorrectionAction) {
  return defineEventHandler(async event => {
    setHeader(event, 'cache-control', 'no-store')
    let body: unknown
    if (getMethod(event) === 'POST') {
      try { body = await readBody(event) }
      catch { setResponseStatus(event, 400); return { error: { code: 'invalid_request', message: 'Malformed JSON request body' } } }
    }
    const output = handleEventCorrectionRequest({ action, method: getMethod(event), id: getRouterParam(event, 'id'), query: getQuery(event), body, headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') } }, { db: useDb(), apiToken: useRuntimeConfig().apiToken })
    setResponseStatus(event, output.status)
    return output.body
  })
}
