import { getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { DECLARATION_VIEWS } from '../../../lib/platform/declarations'
import { listPlatformDeclarations } from '../../utils/platform-declarations'

const fail = (message: string): never => { throw createError({ statusCode: 400, statusMessage: message }) }
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const positive = (value: unknown, name: string, max?: number) => {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (max != null && parsed > max)) fail(`${name} must be a positive integer${max != null ? ` <= ${max}` : ''}`)
  return parsed
}

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '本地查询申报记录',
    description:
      '只读本地 apply_list（queryList）申报投影，不访问外部平台。view=records 按业务编号组织，返回匹配内容版本、全部版本/观察计数、企业归属与冲突；view=isolated 单独返回缺编号/编号冲突/原文不可核实且无法并入任何记录的观察。未知事项、年度或状态保持 null，不猜填称号或年份。筛选条件在 typed 投影与既有 observation/relation 上执行，不读取或解析 raw JSON。分页最多 200。',
    parameters: [
      { name: 'view', in: 'query', schema: { type: 'string', enum: ['records', 'isolated'], default: 'records' } },
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '企业名称关键词或统一社会信用代码关键词；只通过已归属观察匹配。' },
      { name: 'enterpriseId', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'platformKey', in: 'query', schema: { type: 'string' }, description: '精确申报编号；不跨接口、不按名称合并。' },
      { name: 'declareKind', in: 'query', schema: { type: 'string' }, description: '原 sblx 事项值；字典外值按原值匹配。' },
      { name: 'year', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '来源明确年份；未知/缺省不匹配。' },
      { name: 'status', in: 'query', schema: { type: 'string' }, description: '原 cszt 状态值。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
    ],
    responses: {
      200: { description: 'rows[{kind:record,...}|{kind:observation,...}], total/page/pageSize/view。' },
      400: { description: '分页、ID、年份或 view 取值非法。' },
    },
  },
})

export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  const q = getQuery(event)
  const view = q.view === undefined || q.view === '' ? 'records' : String(q.view)
  if (!DECLARATION_VIEWS.includes(view as (typeof DECLARATION_VIEWS)[number])) fail('Unknown declaration view')
  try {
    return listPlatformDeclarations({
      view,
      q: text(q.q),
      enterpriseId: positive(q.enterpriseId, 'enterpriseId'),
      platformKey: text(q.platformKey),
      declareKind: text(q.declareKind),
      year: positive(q.year, 'year'),
      status: text(q.status),
      page: positive(q.page, 'page') ?? 1,
      pageSize: positive(q.pageSize, 'pageSize', 200) ?? 25,
    }, useDb())
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'declaration query failed' })
  }
})
