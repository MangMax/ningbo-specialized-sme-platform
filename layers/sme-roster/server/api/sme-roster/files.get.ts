import { useDb } from '@db'
import { inArray } from 'drizzle-orm'
import { rosterFileClassification, storedFile } from '@db/schema'
import { createFileStore } from '#core/server/utils/file-store'
import { fileListQuery } from '#core/server/utils/file-list-query'
import { rosterFileServerCategory } from '../../modules/sme-roster/files'

const { listStoredFiles } = createFileStore([rosterFileServerCategory])

defineRouteMeta({
  openAPI: {
    tags: ['名单文件'],
    summary: '列出优质中小企业名单文件',
    parameters: [
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '搜索显示名称或原始文件名。' },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源，多个值以逗号分隔。' },
      { name: 'categoryState', in: 'query', schema: { type: 'string' }, description: '分类状态，多个值以逗号分隔。' },
      { name: 'parseState', in: 'query', schema: { type: 'string' }, description: '解析状态，多个值以逗号分隔。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, default: 50, maximum: 200 } },
    ],
    responses: { 200: { description: '已纳入名录模块且未移出的文件，含名单分类、内容分段及业务引用。' } },
  },
})

export default defineEventHandler(event => {
  const db = useDb()
  const query = getQuery(event)
  const membership = inArray(storedFile.id, db.select({ id: rosterFileClassification.fileId }).from(rosterFileClassification))
  return listStoredFiles(db, { ...query, includeRemoved: false, ...fileListQuery(query) }, membership)
})
