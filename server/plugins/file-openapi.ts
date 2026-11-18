import { getRequestURL } from 'h3'
import { serverFileCategories } from '../file-category-modules'
import { extendFileOpenApi } from '../utils/file-openapi'

export default defineNitroPlugin(app => {
  if (!import.meta.dev) return
  // Nitro extracts defineRouteMeta statically. Extend its development document from the installed server modules.
  app.hooks.hook('beforeResponse', (event, response) => {
    const path = getRequestURL(event).pathname
    const config = useRuntimeConfig(event)
    const base = config.app.baseURL.replace(/\/$/, '')
    const discoveryPath = config.nitro?.openAPI?.route || '/_openapi.json'
    if (path === base + discoveryPath && response.body && typeof response.body === 'object') {
      const document = structuredClone(response.body)
      extendFileOpenApi(document, serverFileCategories)
      response.body = document
    }
  })
})
