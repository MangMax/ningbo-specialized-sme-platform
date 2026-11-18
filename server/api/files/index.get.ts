import { useDb } from '@db'
import { listStoredFiles } from '../../utils/stored-files'

defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '列出文件库',
    description:
      '只读列表，不扫盘或回填；rescan兼容参数不再执行维护。多值参数用逗号分隔。',
    parameters: [
      {
        name: 'q',
        in: 'query',
        schema: { type: 'string' },
        description: '用户可见名称或磁盘文件名关键词(子串)。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
      {
        name: 'rescan',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '兼容保留；不再触发扫盘或回填。',
      },
    ],
    responses: {
      200: {
        description: '分页只读文件列表。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['rows', 'total'],
              properties: {
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    required: ['displayName', 'filename'],
                    properties: {
                      displayName: {
                        type: 'string',
                        description: '用户可见名称；未设置时等于磁盘文件名 filename。',
                      },
                      filename: {
                        type: 'string',
                        description: '磁盘上的原始文件名；修改 displayName 不会改动它。',
                      },
                    },
                  },
                },
                total: { type: 'integer', description: '符合筛选条件的文件总数。' },
                backfill: {
                  type: 'object',
                  description: '历史兼容字段；只读列表不再返回回填统计。',
                },
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler(async (event) => {
  const db = useDb()
  const q = getQuery(event)

  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }

  const result = listStoredFiles(db, {
    ...q,
    includeRemoved: false,
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
    page: num(q.page, 1),
    pageSize: num(q.pageSize, 50),
  })

  return {
    rows: result.rows,
    total: result.total,
  }
})
