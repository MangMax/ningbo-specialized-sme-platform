import { onResponse } from 'nitro/h3'
import { registeredCredentials } from '../lib/app-modules'
import { extendCredentialOpenApi, type CredentialOpenApiDocument } from '../layers/core/server/utils/credential-openapi'
import { extendFileOpenApi, type FileOpenApiDocument } from '../layers/core/server/utils/file-openapi'
import { jobSpecs } from '../layers/core/server/utils/job-spec-registry'
import { serverFileCategories } from '../layers/core/server/utils/file-category-runtime'
import { extendRosterImportOpenApi, type RosterImportOpenApiDocument } from '../layers/sme-roster/server/modules/sme-roster/roster-import-openapi'

type JobParamsContent = {
  content?: { 'application/json'?: { schema?: { properties?: { params?: { description?: string } } } } }
}
type DevelopmentOpenApiDocument = FileOpenApiDocument & CredentialOpenApiDocument & RosterImportOpenApiDocument & {
  paths?: { '/api/jobs'?: { post?: { requestBody?: JobParamsContent } } }
}

// Extend the generated development document with metadata from installed modules.
export default onResponse(async response => {
  if (!response.ok || !response.body) return
  const document: DevelopmentOpenApiDocument = await response.json()
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
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return Response.json(document, { status: response.status, headers })
})
