import { closeApplicationLogging, newLogContext } from '../../lib/logging'
import { setHeader } from 'h3'
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
    event.context.log?.set(event.context.applicationLogContext)
    const path = event.path.split('?')[0]!
    if (path === '/api/logs' || path.startsWith('/api/logs/')) event.context._evlogShouldEmit = false
  })
  app.hooks.hook('close', closeApplicationLogging)
})
