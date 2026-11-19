import { describe, expect, it, vi } from 'vitest'

interface JsonSchema {
  type?: string
  description?: string
  required?: string[]
  enum?: string[]
  nullable?: boolean
  format?: string
  additionalProperties?: boolean
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
}

interface CapturedRouteMeta {
  openAPI?: {
    responses?: Record<
      number,
      {
        description?: string
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

    await import('../../../layers/core/server/api/files/index.get')

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

describe('PATCH /api/files/{id} OpenAPI response', () => {
  it('declares the updated file row schema including display and disk names', async () => {
    let captured: CapturedRouteMeta | undefined
    vi.stubGlobal('defineRouteMeta', (meta: CapturedRouteMeta) => {
      captured = meta
      return meta
    })
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.resetModules()

    await import('../../../layers/core/server/api/files/[id].patch')

    const response = captured?.openAPI?.responses?.[200]
    const schema = response?.content?.['application/json']?.schema
    expect(response?.description).toContain('更新后的文件行')
    expect(schema?.type).toBe('object')
    expect(schema?.required).toEqual([
      'id', 'relPath', 'displayName', 'filename', 'ext', 'bytes', 'sha256', 'createdAt', 'removedAt',
    ])
    expect(schema?.properties?.id?.type).toBe('integer')
    expect(schema?.properties?.relPath?.type).toBe('string')
    expect(schema?.properties?.displayName?.type).toBe('string')
    expect(schema?.properties?.filename?.description).toContain('原始文件名')
  })
})
