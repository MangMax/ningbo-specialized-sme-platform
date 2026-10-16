import { describe, expect, it, vi } from 'vitest'

interface JsonSchema {
  type?: string
  description?: string
  required?: string[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
}

interface CapturedRouteMeta {
  openAPI?: {
    responses?: Record<
      number,
      {
        content?: Record<string, { schema?: JsonSchema }>
      }
    >
  }
}

describe('GET /api/files OpenAPI response', () => {
  it('declares displayName and filename with their user-visible and disk-file meanings', async () => {
    let captured: CapturedRouteMeta | undefined
    vi.stubGlobal('defineRouteMeta', (meta: CapturedRouteMeta) => {
      captured = meta
      return meta
    })
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.resetModules()

    await import('../server/api/files/index.get')

    const schema = captured?.openAPI?.responses?.[200]?.content?.['application/json']?.schema
    expect(schema?.type).toBe('object')
    expect(schema?.required).toEqual(['rows', 'total'])
    expect(schema?.properties?.rows?.type).toBe('array')
    expect(schema?.properties?.rows?.items?.required).toEqual(['displayName', 'filename'])

    const row = schema?.properties?.rows?.items?.properties
    expect(row?.displayName).toEqual({
      type: 'string',
      description: '用户可见名称；未设置时等于磁盘文件名 filename。',
    })
    expect(row?.filename).toEqual({
      type: 'string',
      description: '磁盘上的原始文件名；修改 displayName 不会改动它。',
    })
  })
})
