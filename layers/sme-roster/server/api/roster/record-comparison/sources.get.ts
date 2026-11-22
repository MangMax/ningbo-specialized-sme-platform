import { ZodError } from 'zod'
import { comparisonSourceCatalogInput } from '#sme-roster/lib/roster/record-comparison'
import { readPostgresRecordComparisonSources } from '#sme-roster/server/utils/record-comparison-catalog-postgres'
import { usePostgresRosterDb } from '#sme-roster/server/utils/postgres-roster-db'

defineRouteMeta({ openAPI: { tags: ['名录'], summary: '记录级对比来源选择目录', description: '逐项列已归档查询、导出批次、正式文件的 ID、中文名称、时间与范围状态。只供显式选择；目录不证明全覆盖，也不默认选择最新。', parameters: [
  { name: 'kind', in: 'query', schema: { type: 'string', enum: ['query', 'export_batch', 'official_document'] } },
  { name: 'ids', in: 'query', schema: { type: 'array', maxItems: 500, items: { type: 'integer' } }, description: '正式文件按既有正式事件的原路径去重；缺 source_document 时使用负的首条 record_evidence ID，只供只读选择，不是外键或覆盖证明。可选：同 kind 的显式来源 ID，供恢复所选名称；不扫描其他目录页。' },
  { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
], responses: { 200: { description: 'rows[{kind,id,label,subtitle,titleCode,titleName,observedAt,status,selectable,...}]、total、counts、page、pageSize；ID 与对比接口入参直接对应。平台查询行增量返回 confirmedEnterprises[{relationId,sequenceNo,enterpriseId,enterpriseName,nameRaw,matchBasis,aliasConfirmed,mergedFromEnterpriseId}] 与 recordNames[]：仅取本页 query IDs 的已确认 platform_relation 企业，保留一对多与原行名称；recordNames 是未确认关系的平台原行名称，不冒充正式企业名。' }, 400: { description: '筛选或分页非法。' } } } })
export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  const query = getQuery(event)
  const controller = new AbortController()
  const abort = () => { if (!event.node.res.writableFinished) controller.abort() }
  event.node.req.once('aborted', abort)
  event.node.res.once('close', abort)
  if (event.node.req.aborted || event.node.res.destroyed || event.node.res.closed || event.node.res.writableFinished) controller.abort()
  try {
    const input = comparisonSourceCatalogInput.parse({ kind: query.kind, ids: query.ids === undefined ? undefined : (Array.isArray(query.ids) ? query.ids : [query.ids]).flatMap(value => String(value).split(',')).map(value => /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : NaN), page: query.page === undefined ? undefined : Number(query.page), pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize) })
    const pg = usePostgresRosterDb()
    return await readPostgresRecordComparisonSources(pg, input, controller.signal)
  } catch (error) {
    if (error instanceof ZodError) throw createError({ statusCode: 400, statusMessage: error.message })
    throw error
  } finally { event.node.req.off('aborted', abort); event.node.res.off('close', abort) }
})
