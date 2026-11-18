import { ZodError } from 'zod'
import { useDb } from '@db'
import { parseRecordComparisonQuery } from '#sme-roster/lib/roster/record-comparison'
import { readRecordComparison } from '#sme-roster/server/utils/record-comparison-read'

defineRouteMeta({ openAPI: { tags: ['名录'], summary: '记录级对比（只读）', description: '明确来源 ID 集、时点和逐事件粒度。原观察级结果保留，增量返回所选范围的业务/版本分组及业务、版本、观察、未知计数；businessPage/businessPageSize独立分页，不受事件classification分页影响。历史判断与后续流程、同源现状观察分开；缺完整性或版本证明时保留 unknown/not_comparable。', parameters: [
  { name: 'queryIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'exportBatchIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'officialSourceDocumentIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'proofIds', in: 'query', schema: { type: 'array', items: { type: 'integer' } }, description: 'Confirmed stored scope proof IDs; optional' },
  { name: 'asOf', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'enterpriseId', in: 'query', schema: { type: 'integer' } }, { name: 'titleCode', in: 'query', schema: { type: 'string' } }, { name: 'classification', in: 'query', schema: { type: 'string' } },
  { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
  { name: 'businessPage', in: 'query', schema: { type: 'integer', default: 1 }, description: '所选观察业务组独立页码，不改变事件页码' },
  { name: 'businessPageSize', in: 'query', schema: { type: 'integer', default: 25, maximum: 200 }, description: '业务组每页数量，计数在分页前计算' },
], responses: { 200: { description: '逐事件行、全范围分类与各粒度计数、逐查询覆盖和逐原行现状观察；businessGroups独立分页与scope，businessCounts为筛选后分页前的可核实业务/版本/全部观察/独立未知观察计数。' }, 400: { description: '来源 ID、时点或筛选非法，或指定来源不存在。' } } } })
export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  const controller = new AbortController()
  const abort = () => { if (!event.node.res.writableFinished) controller.abort() }
  event.node.req.once('aborted', abort)
  event.node.res.once('close', abort)
  if (event.node.req.aborted || event.node.res.destroyed || event.node.res.closed || event.node.res.writableFinished) controller.abort()
  try { const db = useDb(); const input = parseRecordComparisonQuery(getQuery(event)); return await readRecordComparison(db, input, controller.signal) }
  catch (error) { if (error instanceof ZodError || error instanceof Error && (error.message.startsWith('source_set_') || error.message.startsWith('duplicate_'))) throw createError({ statusCode: 400, statusMessage: error.message }); throw error }
  finally { event.node.req.off('aborted', abort); event.node.res.off('close', abort) }
})
