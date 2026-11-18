import { requestLogContext } from '../../../core/lib/logging'
import { platformMcpContextKey } from '../utils/mcp-platform-query'

const tools = new Set(['query_platform', 'submit_platform_batch', 'retry_platform_batch'])
export default defineNitroPlugin(app => {
  // Toolkit resolves definitions for each request before creating its SDK server.
  // Clone only this slice's handlers; no global mutable request context or input fields.
  app.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const context = requestLogContext(event)
    config.tools = config.tools?.map(tool => tools.has(tool.name ?? '') ? {
      ...tool,
      handler: (input: unknown, extra: unknown) => tool.handler(input, { ...extra as object, [platformMcpContextKey]: context } as never),
    } : tool)
  })
})
