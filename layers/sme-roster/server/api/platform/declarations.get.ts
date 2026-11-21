import { getQuery, setHeader } from 'h3'
import { declarationFilterFromQuery } from '../../../lib/platform/declarations'
import { listPlatformArchive } from '../../utils/platform-archive-read'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '本地查询申报记录',
    description:
      '只读本地 apply_list（queryList）申报投影，不访问外部平台。view=records 按业务编号组织，返回匹配内容版本、全部版本/观察计数、企业归属与冲突；view=isolated 单独返回缺编号/编号冲突/原文不可核实且无法并入任何记录的观察。未知事项、年度或状态保持 null，不猜填称号或年份。筛选条件在 typed 投影与既有 observation/relation 上执行，不读取或解析 raw JSON。分页最多 200。',
    parameters: [
      { name: 'titleRaw', in: 'query', schema: { type: 'string' }, description: '每条原始 rdjb 的字符串原值，精确匹配；独立于来源查询 rdjb 范围，未知值保留，缺失不匹配。' },
      { name: 'view', in: 'query', schema: { type: 'string', enum: ['records', 'isolated'], default: 'records' } },
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '企业名称关键词或统一社会信用代码关键词；只通过已归属观察匹配。' },
      { name: 'enterpriseId', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'platformKey', in: 'query', schema: { type: 'string' }, description: '精确申报编号；不跨接口、不按名称合并。' },
      { name: 'declareKind', in: 'query', schema: { type: 'string' }, description: '事项值；已知 申请/更新/复核 归一为 apply/update/review 后匹配，字典外原值保留。' },
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

export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    return await listPlatformArchive('declarations', declarationFilterFromQuery(getQuery(event)))
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'declaration query failed' })
  }
})
