import { statisticsInteger } from '../../utils/statistics-query'
import { useDb } from '@db'
import { TITLE_ORDER } from '#sme-roster/lib/labels'
import { readDistrictStatistics } from '#sme-roster/lib/roster/district-statistics'


defineRouteMeta({ openAPI: { tags: ['统计'], summary: '当前有效企业按当前属地分布及同口径分页明细', description: '每企业每称号一次；unknown 为缺失属地，省略 district 为全部；独立管理区保留。汇总和明细在同一读事务中共享上海评价日及现行有效规则。', parameters: [
{ name: 'title', in: 'query', schema: { type: 'string', enum: TITLE_ORDER } },
{ name: 'district', in: 'query', schema: { type: 'string' } },
{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
{ name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
], responses: { 200: { description: 'districts/titles 全量汇总；rows/total 为相同有效行集按称号及属地筛选，先计数后分页；含时点及规则版本。' } } } })
export default defineEventHandler(event => {
  const q = getQuery(event), asOf = Date.now()
  if (q.title !== undefined && (typeof q.title !== 'string' || !TITLE_ORDER.includes(q.title)) || q.district !== undefined && (typeof q.district !== 'string' || !q.district.trim() || q.district.length > 100 || q.district !== q.district.trim())) throw createError({ statusCode: 400, statusMessage: 'Invalid district statistics scope' })
  return readDistrictStatistics(useDb(), { title: q.title as string | undefined, district: q.district as string | undefined, page: statisticsInteger(q.page, 1, Number.MAX_SAFE_INTEGER, 'Invalid district statistics scope'), pageSize: statisticsInteger(q.pageSize, 25, 200, 'Invalid district statistics scope') }, asOf)
})
