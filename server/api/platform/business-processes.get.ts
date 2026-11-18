import { getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { businessProcessFilterFromQuery } from '../../../layers/sme-roster/lib/platform/business-processes'
import { listTargetBusinessProcesses } from '../../../layers/sme-roster/server/utils/platform-business-processes-target'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '本地查询关联办理记录',
    description:
      '只读本地 business_list（businessList）办理投影，不访问外部平台。view=records 按办理编号组织，返回匹配内容版本、全部版本/观察计数、企业归属、观察到的明确称号范围与冲突；view=isolated 单独返回缺编号/编号冲突/原文无法核实且无法并入任何记录的观察。titleRaw 筛选逐行 rdjb 原值；rdjb 筛选使用来源查询的显式范围，不是逐行称号事实；未知事项、年度、状态或批次保持 null，不猜填。筛选在目标 typed 投影、观察、采集与别名上执行，不读取或解析 raw JSON。分页最多 200。',
    parameters: [
      { name: 'titleRaw', in: 'query', schema: { type: 'string' }, description: '每条原始 rdjb 的字符串原值，精确匹配；独立于来源查询 rdjb 范围，未知值保留，缺失不匹配。' },
      { name: 'view', in: 'query', schema: { type: 'string', enum: ['records', 'isolated'], default: 'records' } },
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '企业名称关键词或统一社会信用代码关键词；只通过已归属观察匹配。' },
      { name: 'enterpriseId', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'platformKey', in: 'query', schema: { type: 'string' }, description: '精确办理编号；不跨接口、不按名称合并。' },
      { name: 'rdjb', in: 'query', schema: { type: 'string', enum: ['1', '2', '3'] }, description: '来源查询的显式称号范围（1 创新型、2 专精特新、3 小巨人）；不是逐行称号事实。' },
      { name: 'declareKind', in: 'query', schema: { type: 'string' }, description: '事项值；已知 申请/更新/复核 归一为 apply/update/review 后匹配，字典外原值保留。' },
      { name: 'year', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '来源明确业务年；未知/缺省不匹配。' },
      { name: 'status', in: 'query', schema: { type: 'string' }, description: '原 cszt 办理状态值。' },
      { name: 'batch', in: 'query', schema: { type: 'string' }, description: '原 whpc 维护批次值。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
    ],
    responses: {
      200: { description: 'rows[{kind:record,...}|{kind:observation,...}], total/page/pageSize/view。' },
      400: { description: '分页、ID、年份或 view/rdjb 取值非法。' },
    },
  },
})

export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    return listTargetBusinessProcesses(businessProcessFilterFromQuery(getQuery(event)), useDb())
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'business process query failed' })
  }
})
