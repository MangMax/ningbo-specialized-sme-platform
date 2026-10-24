import { requestLogContext } from '../../lib/logging'
import { operationLogContext } from '../utils/operation-log-context'

const contextTools = new Set([
  'preflight_roster_batch', 'save_roster_batch',
  'submit_event_archive_candidate_task', 'retry_event_archive_candidate_task', 'cancel_event_archive_candidate_task',
  'submit_event_annual_correspondence_task', 'retry_event_annual_correspondence_task', 'cancel_event_annual_correspondence_task',
])

export default defineNitroPlugin(app => {
  app.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const context = requestLogContext(event)
    config.tools = config.tools?.map(tool => {
      if (!contextTools.has(tool.name)) return tool
      const handler = tool.handler
      return { ...tool, handler: (...args: Parameters<typeof handler>) => operationLogContext.run(context, () => handler(...args)) }
    })
  })
})
