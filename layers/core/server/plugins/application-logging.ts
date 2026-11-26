import type { RequestLogger } from 'evlog'
import type { LogContext } from '../../lib/logging/contract'
import { definePlugin } from 'nitro'
import { getEventContext, isEvent, type HTTPEvent } from 'nitro/h3'
import { closeApplicationLogging, matchedHttpRoute, newLogContext } from '../../lib/logging'

type RequestContext = ReturnType<typeof getEventContext> & {
  applicationLogContext?: LogContext
  applicationLogEnriched?: boolean
  log?: Pick<RequestLogger, 'set'>
  matchedRoute?: { route?: string; path?: string }
}

function requestContextOf(event: HTTPEvent): RequestContext {
  return getEventContext(event)
}

function enrichRequestLog(event: HTTPEvent) {
  try {
    const requestContext = requestContextOf(event)
    if (!requestContext.log || requestContext.applicationLogEnriched) return
    const context = requestContext.applicationLogContext
    const route = matchedHttpRoute(requestContext)
    requestContext.log.set({
      ...context,
      ...(route ? { httpRoute: route } : {}),
      ...(context?.module !== undefined ? { applicationLogModule: context.module } : {}),
    })
    requestContext.applicationLogEnriched = true
  } catch {
    /* Runtime diagnostics must never change the business response. */
  }
}

export default definePlugin(app => {
  app.hooks.hook('request', event => {
    const requestContext = requestContextOf(event)
    const context = newLogContext()
    requestContext.applicationLogContext = context
    requestContext.requestId = context.requestId
    if (context.requestId && isEvent(event)) {
      event.res.headers.set('x-request-id', context.requestId)
      event.res.errHeaders.set('x-request-id', context.requestId)
    }
  })
  app.hooks.hook('response', (_response, event) => enrichRequestLog(event))
  app.hooks.hook('error', (_error, context) => {
    if (context?.event) enrichRequestLog(context.event)
  })
  app.hooks.hook('close', closeApplicationLogging)
})
