import { useDb } from '@db'
import { createFileStore } from '../utils/file-store'
import { fileListQuery } from '../utils/file-list-query'

const { listStoredFiles } = createFileStore([])

defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '列出平台文件库',
    parameters: [
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '搜索显示名称或原始文件名。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, default: 50, maximum: 200 } },
    ],
    responses: { 200: { description: '已登记且未移出的平台文件，包含分页 rows 与 total。' } },
  },
})

export default defineEventHandler(event => listStoredFiles(useDb(), fileListQuery(getQuery(event))))
