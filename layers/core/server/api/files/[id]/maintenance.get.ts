import { readPostgresFileMaintenance } from '../../../utils/file-maintenance-postgres'
import { usePostgresFileDb } from '../../../utils/file-store-postgres'
defineRouteMeta({ openAPI: { tags: ['文件库'], summary: '读取文件维护状态与追加历史', description: '按稳定 ID 精确读取，不扫描磁盘。page 默认1，pageSize默认50、上限100。只返回元数据变更，不含文件字节、OCR 或解析原文。', parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }], responses: { 200: { description: '{ file, revision, total, rows, page, pageSize }。' }, 400: { description: '非法分页。' }, 404: { description: '文件不存在。' } } } })
export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '文件 id 非法' })
  const q = getQuery(event)
  const page = q.page === undefined ? 1 : Number(q.page)
  const pageSize = q.pageSize === undefined ? 50 : Number(q.pageSize)
  try {
    const pg = usePostgresFileDb()
    return await readPostgresFileMaintenance(pg, id, page, pageSize)
  }
  catch (error) { throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message }) }
})
