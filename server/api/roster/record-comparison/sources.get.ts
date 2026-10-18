import { ZodError } from 'zod'
import { useDb } from '@db'
import { comparisonSourceCatalogInput } from '~~/lib/roster/record-comparison'
import { listRecordComparisonSources } from '~~/server/utils/record-comparison'

defineRouteMeta({ openAPI: { tags: ['名录'], summary: '记录级对比来源选择目录', description: '逐项列已归档查询、导出批次、正式文件的 ID、中文名称、时间与范围状态。只供显式选择；目录不证明全覆盖，也不默认选择最新。', parameters: [
  { name: 'kind', in: 'query', schema: { type: 'string', enum: ['query', 'export_batch', 'official_document'] } },
  { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
], responses: { 200: { description: 'rows[{kind,id,label,subtitle,titleCode,titleName,observedAt,status,selectable,...}]、total、counts、page、pageSize；ID 与对比接口入参直接对应。' }, 400: { description: '筛选或分页非法。' } } } })
export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  const query = getQuery(event)
  try {
    return listRecordComparisonSources(useDb(), comparisonSourceCatalogInput.parse({ kind: query.kind, page: query.page === undefined ? undefined : Number(query.page), pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize) }))
  } catch (error) {
    if (error instanceof ZodError) throw createError({ statusCode: 400, statusMessage: error.message })
    throw error
  }
})
