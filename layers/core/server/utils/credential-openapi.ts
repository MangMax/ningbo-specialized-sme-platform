import type { AppCredential } from '../../lib/core/module-registry'

type Schema = {
  type?: string
  required?: string[]
  properties?: Record<string, object>
  enum?: string[]
}
type JsonBody = { description?: string; content?: { 'application/json'?: { schema?: Schema } } }
type Operation = {
  summary?: string
  description?: string
  requestBody?: JsonBody
  responses?: { 200?: JsonBody }
}
type RevealOperation = { parameters?: { name: string; in: string; schema?: Schema }[] }

export interface CredentialOpenApiDocument {
  paths?: {
    '/api/settings/credentials'?: Partial<Record<'get' | 'patch' | 'delete', Operation>>
    '/api/settings/credentials/{key}/reveal'?: { post?: RevealOperation }
  }
}

export function extendCredentialOpenApi(document: CredentialOpenApiDocument, credentials: readonly AppCredential[]) {
  const state = document.paths?.['/api/settings/credentials']
  const keys = credentials.map(({ key }) => key)
  const names = credentials.map(({ name }) => name)
  const actions = credentials.flatMap(({ openAPI }) => openAPI?.actionLabel ?? [])
  const isAnyCredential = { type: 'string', enum: keys }
  const reveal = document.paths?.['/api/settings/credentials/{key}/reveal']?.post
  const revealKey = reveal?.parameters?.find(parameter => parameter.name === 'key' && parameter.in === 'path')
  if (revealKey) revealKey.schema = isAnyCredential
  if (!state) return

  const patch = state.patch
  if (patch && names.length) patch.summary = `保存 ${names.join(' 或')}；省略字段保持不变，空白拒绝`
  const patchSchema = patch?.requestBody?.content?.['application/json']?.schema
  if (patchSchema) {
    patchSchema.properties = Object.fromEntries(credentials.map(({ key, singleLine, openAPI }) => [key, {
      type: 'string',
      description: openAPI?.patchDescription ?? (singleLine ? '非空且无换行，最多 65536 字符' : '非空，最多 65536 字符'),
    }]))
  }
  const deleteSchema = state.delete?.requestBody?.content?.['application/json']?.schema
  if (deleteSchema) deleteSchema.properties = { key: isAnyCredential }

  const properties = Object.fromEntries(credentials.map(({ key, environment }) => [key, {
    type: 'object',
    required: ['configured', 'source', 'masked', 'updatedAt', 'hasSaved'],
    properties: {
      configured: { type: 'boolean' },
      source: { type: 'string', enum: ['saved', ...(environment ?? []), 'none'] },
      masked: { type: 'string' },
      updatedAt: { type: 'string', nullable: true },
      hasSaved: { type: 'boolean' },
    },
  }]))
  for (const operation of Object.values(state)) {
    const effect = actions.length ? `，不触发 ${actions.join(' 或')}` : ''
    operation.description += `保存不代表验证可用${effect}。`
    const response = operation.responses?.[200]
    const schema = response?.content?.['application/json']?.schema
    if (response && schema) {
      response.description = `${names.length ? names.join(' 与') + ' ' : '凭据'}遮罩状态，不含原值`
      schema.required = keys
      schema.properties = properties
    }
  }
}
