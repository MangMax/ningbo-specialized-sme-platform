import { enterpriseReads } from '../utils/enterprise-read'

export default defineNitroPlugin(async app => {
  app.hooks.hook('close', () => enterpriseReads.close())
  // Load code before accepting traffic; this performs no business read/cache fill.
  await enterpriseReads.start()
})
