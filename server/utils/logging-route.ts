import { defineEventHandler, getQuery, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3'
import { applicationLogs } from '../../lib/logging'
import { dispatchLogAction, type LogAction } from '../../lib/logging/application'
import { logAccessAllowed } from './logging-access'
export function createLoggingRoute(action: LogAction) {
  return defineEventHandler(async event => {
    const authorized = logAccessAllowed(event)
    // Check before body parsing/storage acquisition: sensitive reads fail closed too.
    if (!authorized) { setResponseStatus(event, 401); setHeader(event, 'cache-control', 'no-store'); return { error: { code: 'log_access_denied' } } }
    let input: Record<string, unknown> = action === 'detail' ? { id: getRouterParam(event, 'id') } : getQuery(event)
    if (['setPolicy','clear'].includes(action)) {
      const length = Number(event.node.req.headers['content-length'])
      if (!Number.isInteger(length) || length < 1 || length > 4096) { setResponseStatus(event, 413); setHeader(event, 'cache-control', 'no-store'); return { error: { code: 'log_body_too_large' } } }
      input = await readBody(event)
    }
    const result = await dispatchLogAction(applicationLogs(), action, input, authorized)
    setResponseStatus(event, result.status)
    for (const [key,value] of Object.entries(result.headers)) setHeader(event, key, value)
    return result.body
  })
}
