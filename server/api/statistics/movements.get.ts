import { statisticsInteger } from '../../utils/statistics-query'
import { useDb } from '@db'
import { MOVEMENT_KINDS, type MovementKind, readMovementStatistics } from '~~/lib/roster/movement-statistics'

defineRouteMeta({ openAPI: { tags: ['统计'], summary: '全部已录入企业的迁入迁出注销发生事实统计', description: '当前修订、证据完整且已确认；按企业和事实种类去重。year 为发生年或 unknown；status 为 confirmed、unknown（已确认但发生年未知）或 pending。非互斥当前状态。', parameters: [
  { name: 'kind', in: 'query', schema: { type: 'string', enum: [...MOVEMENT_KINDS] } },
  { name: 'year', in: 'query', schema: { type: 'string', description: '四位发生年或 unknown；省略为全部' } },
  { name: 'status', in: 'query', schema: { type: 'string', enum: ['confirmed', 'unknown', 'pending'], default: 'confirmed' } },
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
], responses: { 200: { description: 'kinds 按发生年汇总；rows/total 同时按种类及状态筛选，total 先于分页。years 包含全部可选发生年。' } } } })
export default defineEventHandler(event => {
  const q = getQuery(event)
  if (q.kind !== undefined && !MOVEMENT_KINDS.includes(q.kind as MovementKind) || q.status !== undefined && !['confirmed', 'unknown', 'pending'].includes(q.status as string) || q.year !== undefined && (typeof q.year !== 'string' || !/^(unknown|[0-9]{4})$/.test(q.year))) throw createError({ statusCode: 400, statusMessage: 'Invalid movement scope' })
  return readMovementStatistics(useDb(), { kind: q.kind as MovementKind | undefined, year: q.year as string | undefined, status: (q.status as string) ?? 'confirmed', page: statisticsInteger(q.page, 1, Number.MAX_SAFE_INTEGER, 'Invalid pagination'), pageSize: statisticsInteger(q.pageSize, 25, 200, 'Invalid pagination') })
})
