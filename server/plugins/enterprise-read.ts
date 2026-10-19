import { enterpriseReads } from '../utils/enterprise-read'

export default defineNitroPlugin(app => {
  app.hooks.hook('close', () => enterpriseReads.close())
  // Nitro2 invokes plugins synchronously. Gate requests on code readiness rather
  // than returning an unawaited plugin promise. No business query/cache is warmed.
  const ready = enterpriseReads.start()
  void ready.catch(() => {})
  app.hooks.hook('request', () => ready)
})
