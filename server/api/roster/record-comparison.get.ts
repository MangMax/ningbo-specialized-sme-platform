import { ZodError } from 'zod'
import { useDb } from '@db'
import { parseRecordComparisonQuery } from '~~/lib/roster/record-comparison'
import { readRecordComparison } from '~~/server/utils/record-comparison-read'

defineRouteMeta({ openAPI: { tags: ['名录'], summary: '记录级对比（只读）', description: '明确来源 ID 集、时点和逐事件粒度。历史判断与后续流程、同源现状观察分开；缺完整性或版本证明时保留 unknown/not_comparable。', parameters: [
  { name: 'queryIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'exportBatchIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'officialSourceDocumentIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'proofIds', in: 'query', schema: { type: 'array', items: { type: 'integer' } }, description: 'Confirmed stored scope proof IDs; optional' },
  { name: 'asOf', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'enterpriseId', in: 'query', schema: { type: 'integer' } }, { name: 'titleCode', in: 'query', schema: { type: 'string' } }, { name: 'classification', in: 'query', schema: { type: 'string' } },
  { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
], responses: { 200: { description: '逐事件行、全范围分类与各粒度计数、逐查询覆盖和逐原行现状观察。' }, 400: { description: '来源 ID、时点或筛选非法，或指定来源不存在。' } } } })
export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  try { const db = useDb(); const input = parseRecordComparisonQuery(getQuery(event)); return await readRecordComparison(db, input) }
  catch (error) { if (error instanceof ZodError || error instanceof Error && (error.message.startsWith('source_set_') || error.message.startsWith('duplicate_'))) throw createError({ statusCode: 400, statusMessage: error.message }); throw error }
})
