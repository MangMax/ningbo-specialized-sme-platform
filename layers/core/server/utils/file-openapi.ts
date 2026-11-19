import type { FileCategoryServer } from './file-store'

type Parameter = { name: string; in: string; schema: object; description?: string }
type Content<Schema> = { content?: { 'application/json'?: { schema?: Schema } } }
type Properties = { properties?: Record<string, object> }

export interface FileOpenApiDocument {
  paths?: {
    '/api/files'?: {
      get?: { description?: string; parameters?: Parameter[] }
    }
    '/api/files/{id}'?: {
      patch?: {
        requestBody?: Content<{ oneOf?: Properties[] }>
        responses?: { 200?: Content<Properties> }
      }
    }
  }
}

export function extendFileOpenApi(document: FileOpenApiDocument, categories: readonly FileCategoryServer[]) {
  const list = document.paths?.['/api/files']?.get
  if (list) {
    const parameters = categories.flatMap(({ filters }) => (filters ?? []).map(filter => ({
      name: filter.key,
      in: 'query',
      schema: { type: 'string' },
      description: filter.description,
    })))
    list.parameters = [...parameters, ...(list.parameters ?? [])]
    list.description = [list.description, ...categories.map(category => category.openAPI?.listDescription)]
      .filter(Boolean).join('')
  }

  const patch = document.paths?.['/api/files/{id}']?.patch
  const request = patch?.requestBody?.content?.['application/json']?.schema?.oneOf?.[0]?.properties
  const response = patch?.responses?.[200]?.content?.['application/json']?.schema?.properties
  for (const category of categories) {
    if (request) Object.assign(request, category.metadata?.properties)
    if (response) Object.assign(response, category.openAPI?.rowProperties)
  }
}
