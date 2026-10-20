import { createError, getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { parseCurrentQualifiedQuery } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../utils/enterprise-read'
import { admitEnterpriseResponse } from '../../utils/enterprise-read-response'
import { withEnterpriseReadSignal } from '../../utils/enterprise-read-signal'

defineRouteMeta({ openAPI: {
  tags: ['当前有效称号查询'], summary: '分页查询指定称号当前有效企业',
  description: '一企业一行；只返回该称号 eligible，复用当前名录导出资格规则和完整候选集。计数先于分页，各条件在同一当前周期认定事件及已确认对应的归档平台来源行上按 AND 命中。认定日期仅有年份精度时，闭区间完整包含该年才确定命中；部分重叠计入 uncertainTotal，不补造月日。validYear/maintenanceYear/maintenanceBatch 仅采用已确认当前认定事件对应的成功完整 queryBusList 归档查询条件作为来源行匹配证据；不是本地 dueYear 或任意平台原字段映射。无证据不匹配已设条件，未设条件保留有效企业。options 来自该称号当前有效行可查询见证。读取独立执行器中的同一快照；不返回原始平台字段。',
  parameters: [
    { name: 'titleCode', in: 'query', required: true, schema: { type: 'string', enum: ['little_giant', 'specialized_sme', 'innovative_sme'] } },
    { name: 'q', in: 'query', schema: { type: 'string' }, description: '最长120字符。' },
    { name: 'district', in: 'query', schema: { type: 'string' }, description: '最长40字符。' },
    { name: 'recognitionFrom', in: 'query', schema: { type: 'string', format: 'date' }, description: '认定闭区间起点，必须与 recognitionTo 同时给出；年份精度仅完整覆盖才确定命中。' },
    { name: 'recognitionTo', in: 'query', schema: { type: 'string', format: 'date' }, description: '认定闭区间终点，必须与 recognitionFrom 同时给出。' },
    { name: 'validYear', in: 'query', schema: { type: 'integer', minimum: 1000, maximum: 9999 }, description: '已确认对应来源行在归档 queryBusList 有效年份条件下的匹配证据；不是生命周期 dueYear。' },
    { name: 'maintenanceYear', in: 'query', schema: { type: 'integer', minimum: 1000, maximum: 9999 }, description: '已确认对应来源行在归档 queryBusList 维护年份条件下的匹配证据。' },
    { name: 'maintenanceBatch', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 15 }, description: '归档 queryBusList 维护批次条件；必须同时提供 maintenanceYear。' },
    { name: 'sort', in: 'query', schema: { type: 'string', enum: ['id_asc', 'name_asc', 'name_desc'], default: 'id_asc' } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
  ],
  responses: { 200: { description: 'rows、确定匹配 total、日期精度不确定 uncertainTotal、全称号有效行的 options、page、pageSize、titleCode、ruleVersion、snapshotStartedAt。' }, 400: { description: '查询参数非法。' }, 503: { description: '读取执行器不可用，请重试；不表示零记录。' } },
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
