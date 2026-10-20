import { createError, getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { parseCurrentQualifiedQuery } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../utils/enterprise-read'
import { admitEnterpriseResponse } from '../../utils/enterprise-read-response'
import { withEnterpriseReadSignal } from '../../utils/enterprise-read-signal'

defineRouteMeta({ openAPI: {
  tags: ['当前有效称号查询'], summary: '分页查询指定称号当前有效企业',
  description: '一企业一行；只返回该称号 eligible，复用当前名录导出资格规则和完整候选集。计数先于分页。q 查询现名、已确认曾用名或统代；district 同时过滤。读取独立执行器中的同一快照；不返回原始平台字段。',
  parameters: [
    { name: 'titleCode', in: 'query', required: true, schema: { type: 'string', enum: ['little_giant', 'specialized_sme', 'innovative_sme'] } },
    { name: 'q', in: 'query', schema: { type: 'string' }, description: '最长120字符。' },
    { name: 'district', in: 'query', schema: { type: 'string' }, description: '最长40字符。' },
    { name: 'sort', in: 'query', schema: { type: 'string', enum: ['id_asc', 'name_asc', 'name_desc'], default: 'id_asc' } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
  ],
  responses: { 200: { description: 'rows、完整匹配 total、page、pageSize、titleCode、ruleVersion、snapshotStartedAt。' }, 400: { description: '查询参数非法或含本票未支持的条件。' }, 503: { description: '读取执行器不可用，请重试；不表示零记录。' } },
} })

export default defineEventHandler(event => {
  const parsed = parseCurrentQualifiedQuery(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid current-qualified query' })
  admitEnterpriseResponse(event)
  setHeader(event, 'cache-control', 'no-store')
  return withEnterpriseReadSignal(event, async signal => {
    const result = await enterpriseReads.currentQualifiedJson(useDb().$client.name, parsed.data, signal)
    setHeader(event, 'content-type', 'application/json; charset=utf-8')
    return result.body
  })
})
