import { enterpriseReads } from '../utils/enterprise-read'
import { withEnterpriseReadSignal } from '../utils/enterprise-read-signal'

export default defineNitroPlugin(app => {
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
