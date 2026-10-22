import { closeApplicationLogging, newLogContext } from '../../lib/logging'
import { setHeader, type H3Event } from 'h3'

type MatchedRoute = { path?: unknown }

/** Copy only the framework-matched template; `event.path` may contain concrete IDs or secrets. */
function attachHttpRoute(event: H3Event) {
  try {
    const route = (event.context.matchedRoute as MatchedRoute | undefined)?.path
    if (typeof route === 'string') event.context.log?.set({ httpRoute: route })
  } catch {
    /* Runtime diagnostics must never change the business response. */
  }
}

export default defineNitroPlugin(app => {
  app.hooks.hook('request', event => {
    const context = newLogContext()
    event.context.applicationLogContext = context
    event.context.requestId = context.requestId
    // evlog may already have created its request logger (plugin order is framework-owned).
    event.context.log?.set(context)
    setHeader(event, 'x-request-id', context.requestId!)
  })
  app.hooks.hook('beforeResponse', event => {
    // The router has matched by now; success/denied responses emit after this hook.
    attachHttpRoute(event)
    event.context.log?.set(event.context.applicationLogContext)
    const path = event.path.split('?')[0]!
    if (path === '/api/logs' || path.startsWith('/api/logs/')) event.context._evlogShouldEmit = false
  })
  // Thrown errors emit from evlog's own error hook; attach the template as early as possible.
  app.hooks.hook('error', (_error, context) => {
    if (context?.event) attachHttpRoute(context.event)
  })
  app.hooks.hook('close', closeApplicationLogging)
})
