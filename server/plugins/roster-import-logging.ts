import { requestLogContext } from '../../lib/logging'
import { rosterImportMcpContext } from '../utils/roster-import-mcp-context'

export default defineNitroPlugin(app => {
  app.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const context = requestLogContext(event)
    config.tools = config.tools?.map(tool => {
      if (tool.name !== 'preflight_roster_batch' && tool.name !== 'save_roster_batch') return tool
      const handler = tool.handler
      return { ...tool, handler: (...args: Parameters<typeof handler>) => rosterImportMcpContext.run(context, () => handler(...args)) }
    })
  })
})
