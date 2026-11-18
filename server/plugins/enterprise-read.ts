import { requestLogContext } from '../../layers/core/lib/logging'
import { enterpriseReads } from '../utils/enterprise-read'
import { withEnterpriseReadSignal } from '../../layers/core/server/utils/enterprise-read-signal'

export default defineNitroPlugin(app => {
  // Per-request definitions: never mutate the global tool registry or depend on
  // ambient async context. SDK request IDs are not HTTP correlation IDs.
  app.hooks.hook('mcp:config:resolved', ({ config, event }) => {
    const context = requestLogContext(event)
    config.tools = config.tools.map(tool => {
      if (!['list_enterprises', 'get_enterprise_detail', 'list_current_qualified_enterprises'].includes(tool.name ?? '')) return tool
      const handler = tool.handler as (...args: any[]) => any
      return { ...tool, handler: (input: any, extra: any) => handler(input, { ...extra, logContext: context }) }
    })
  })
  app.hooks.hook('close', () => enterpriseReads.close())
  // Nitro2 invokes plugins synchronously. Gate requests on code readiness rather
  // than returning an unawaited plugin promise. No business query/cache is warmed.
  const ready = enterpriseReads.start()
  void ready.catch(() => {})
  app.hooks.hook('request', event => withEnterpriseReadSignal(event, async signal => {
    await ready
    if (signal.aborted) throw Object.assign(new Error('Enterprise read aborted'), { statusCode: 499 })
  }))
})
