import { ZodError } from 'zod'
import { useDb } from '@db'
import { parseRecordComparisonQuery } from '#sme-roster/lib/roster/record-comparison'
import { previewRecordCorrespondenceImpact } from '#sme-roster/server/utils/record-comparison'
import { previewPostgresRecordCorrespondenceImpact } from '#sme-roster/server/utils/record-comparison-postgres'
import { usePostgresRosterDb } from '#sme-roster/server/utils/postgres-roster-db'

defineRouteMeta({ openAPI: { tags: ['名录'], summary: '旧结论只读影响预览', description: '沿用记录级对比的显式来源集；列出旧结论原值与可能类别，数据问题和模型缺口分列。无写入。', parameters: [
  { name: 'queryIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } }, { name: 'exportBatchIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } }, { name: 'officialSourceDocumentIds', in: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } },
  { name: 'asOf', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'enterpriseId', in: 'query', schema: { type: 'integer' } }, { name: 'titleCode', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
], responses: { 200: { description: '按 difference_reason ID 的旧结论只读候选与影响。' }, 400: { description: '无效来源或参数。' } } } })
export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  if (getQuery(event).proofIds !== undefined) throw createError({ statusCode: 400, statusMessage: 'proofIds are supported only by record-comparison' })
  try {
    const input = parseRecordComparisonQuery(getQuery(event)), pg = usePostgresRosterDb()
    return pg ? await previewPostgresRecordCorrespondenceImpact(pg, input) : previewRecordCorrespondenceImpact(useDb(), input)
  }
  catch (error) { if (error instanceof ZodError || error instanceof Error && (error.message.startsWith('source_set_') || error.message.startsWith('duplicate_'))) throw createError({ statusCode: 400, statusMessage: error.message }); throw error }
})
