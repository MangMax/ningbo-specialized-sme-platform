import { getRequestURL } from 'h3'
import { registeredCredentials } from '../../lib/app-modules'
import { extendCredentialOpenApi, type CredentialOpenApiDocument } from '../../layers/core/server/utils/credential-openapi'
import { extendFileOpenApi, type FileOpenApiDocument } from '../../layers/core/server/utils/file-openapi'
import { jobSpecs } from '../../layers/core/server/utils/job-spec-registry'
import { serverFileCategories } from '../../layers/core/server/utils/file-category-runtime'
import { extendRosterImportOpenApi, type RosterImportOpenApiDocument } from '../../layers/sme-roster/server/modules/sme-roster/roster-import-openapi'

type JobParamsContent = {
  content?: { 'application/json'?: { schema?: { properties?: { params?: { description?: string } } } } }
}
type DevelopmentOpenApiDocument = FileOpenApiDocument & CredentialOpenApiDocument & RosterImportOpenApiDocument & {
  paths?: { '/api/jobs'?: { post?: { requestBody?: JobParamsContent } } }
}

export default defineNitroPlugin(app => {
  if (!import.meta.dev) return
  // Nitro extracts defineRouteMeta statically. Extend its development document from the installed modules.
  app.hooks.hook('beforeResponse', (event, response) => {
    const path = getRequestURL(event).pathname
    const config = useRuntimeConfig(event)
    const base = config.app.baseURL.replace(/\/$/, '')
    const discoveryPath = config.nitro?.openAPI?.route || '/_openapi.json'
    if (path === base + discoveryPath && response.body && typeof response.body === 'object') {
      const document = structuredClone(response.body) as DevelopmentOpenApiDocument
      extendFileOpenApi(document, serverFileCategories)
      extendCredentialOpenApi(document, [...registeredCredentials.values()])
      extendRosterImportOpenApi(document)
      const params = document.paths?.['/api/jobs']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.params
      if (params) {
        const descriptions = jobSpecs()
          .flatMap(spec => spec.openAPIParams ? [spec.openAPIParams] : [])
          .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
          .map(({ description }) => description)
        if (descriptions.length) params.description = descriptions.join('')
      }
      response.body = document
    }
  })
})
