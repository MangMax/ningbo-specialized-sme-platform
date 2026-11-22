import { requestLogContext } from '../../../core/lib/logging'
import { operationLogContext } from '../../../core/server/utils/operation-log-context'

const contextTools = new Set([
  'preflight_roster_batch', 'save_roster_batch',
])

export default defineNitroPlugin(app => {
  app.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const context = requestLogContext(event)
    config.tools = config.tools?.map(tool => {
      if (tool.name === undefined || !contextTools.has(tool.name)) return tool
      const handler = tool.handler
      return { ...tool, handler: (...args: Parameters<typeof handler>) => operationLogContext.run(context, () => handler(...args)) }
    })
  })
})
