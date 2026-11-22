import { listPostgresFiles, usePostgresFileDb } from '../../utils/file-store-postgres'
import { fileListQuery } from '../../utils/file-list-query'
import { serverFileCategories } from '../../utils/file-category-runtime'

defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '列出文件库',
    description: '只读文件列表。多值参数用逗号分隔。',
    parameters: [
      {
        name: 'q',
        in: 'query',
        schema: { type: 'string' },
        description: '用户可见名称或磁盘文件名关键词(子串)。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
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
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const pg = usePostgresFileDb()
  return listPostgresFiles(pg, { ...q, includeRemoved: false, ...fileListQuery(q) }, { categories: serverFileCategories })
})
