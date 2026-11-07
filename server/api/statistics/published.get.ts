import { statisticsInteger } from '../../utils/statistics-query'
import { useDb } from '@db'
import { TITLE_ORDER } from '~~/lib/labels'
import { readPublishedStatistics } from '~~/lib/roster/published-statistics'

defineRouteMeta({ openAPI: { tags: ['统计'], summary: '正式公布累计企业数与同口径明细', description: '每称号按企业去重；仅有正式认定出处的企业。身份歧义单列 pending，累计数不扣减失效、迁出或注销企业。', parameters: [
  { name: 'title', in: 'query', schema: { type: 'string', enum: TITLE_ORDER } },
  { name: 'status', in: 'query', schema: { type: 'string', enum: ['confirmed', 'pending'], default: 'confirmed' } },
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
], responses: { 200: { description: 'titles 为全范围累计数；rows/total 按 title/status 筛选，total 先于分页。' } } } })
export default defineEventHandler(event => {
  const q = getQuery(event)
  if (q.title !== undefined && (typeof q.title !== 'string' || !TITLE_ORDER.includes(q.title)) || q.status !== undefined && !['confirmed', 'pending'].includes(q.status as string)) throw createError({ statusCode: 400, statusMessage: 'Invalid published statistics scope' })
  return readPublishedStatistics(useDb(), { title: q.title as string | undefined, status: (q.status as string) ?? 'confirmed', page: statisticsInteger(q.page, 1, Number.MAX_SAFE_INTEGER, 'Invalid pagination'), pageSize: statisticsInteger(q.pageSize, 25, 200, 'Invalid pagination') })
})
