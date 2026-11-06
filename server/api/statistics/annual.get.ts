import { statisticsInteger } from '../../utils/statistics-query'
import { useDb } from '@db'
import { TITLE_ORDER } from '~~/lib/labels'
import { readAnnualStatistics } from '~~/lib/roster/annual-statistics'
import { qualificationDay } from '~~/lib/roster/current-qualification'

defineRouteMeta({ openAPI: { tags: ['统计'], summary: '年度有效存量和同口径有效/待核企业明细', description: '当前已录入证据重算，非当年归档；历史上海年末，本年评价日。v10 正式期间及排除规则，迁入不授予或恢复资格。', parameters: [
  { name: 'year', in: 'query', schema: { type: 'integer', minimum: 1900 } },
  { name: 'title', in: 'query', schema: { type: 'string', enum: TITLE_ORDER } },
  { name: 'status', in: 'query', schema: { type: 'string', enum: ['effective', 'pending'] } },
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
], responses: { 200: { description: 'years 全范围逐年逐称号数量；rows/total 对应选中年度、称号、状态，先计数后分页；返回评价日、时点和规则版本。' } } } })
export default defineEventHandler(event => {
  const q = getQuery(event), asOf = Date.now()
  const currentYear = Number(qualificationDay(asOf).slice(0, 4))
  if (q.title !== undefined && (typeof q.title !== 'string' || !TITLE_ORDER.includes(q.title)) || q.status !== undefined && !['effective', 'pending'].includes(q.status as string)) throw createError({ statusCode: 400, statusMessage: 'Invalid annual statistics scope' })
  return readAnnualStatistics(useDb(), { year: statisticsInteger(q.year, currentYear, currentYear, 'Invalid annual statistics scope', 1900), title: q.title as string | undefined, status: (q.status as 'effective' | 'pending') ?? 'effective', page: statisticsInteger(q.page, 1, Number.MAX_SAFE_INTEGER, 'Invalid annual statistics scope'), pageSize: statisticsInteger(q.pageSize, 25, 200, 'Invalid annual statistics scope') }, asOf)
})
