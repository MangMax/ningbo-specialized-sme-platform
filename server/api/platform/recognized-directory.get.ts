import { getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { recognizedDirectoryFilterFromQuery } from '../../../lib/platform/recognized-directory'
import { listPlatformRecognizedDirectory } from '../../utils/platform-recognized-directory'

defineRouteMeta({
  openAPI: {
    tags: ['平台业务'],
    summary: '本地查询平台认定目录（镜像）',
    description:
      '只读本地 recognized_list（上游 queryBusList，平台认定目录）typed 投影，不访问外部平台，不写业务数据。这是**平台认定目录镜像**，不是「当前有效企业」资格读模型：目录存在/消失或日期原值都不能推出正式有效或失效，资格仍由 /api/roster/current-enterprises 的既有算法判定。view=records 按目录业务ID组织，返回匹配内容版本、全部版本/观察计数、企业归属、观察到的明确称号范围与冲突（行称号与查询范围不一致时为 title_conflict）；view=isolated 单独返回缺编号/编号冲突/原文无法核实且无法并入任何记录的观察。rddqrq 按原值精确字符串匹配，不解析为日期；whpcyear 只接受显式正整数；whpc/szq 原值精确匹配；rdjb 使用来源查询的显式称号范围，不是逐行称号事实。未知值保持 null/原值，不猜填。筛选在 typed 投影与既有 observation/relation/query 上执行，不读取或解析 raw JSON。分页最多 200。',
    parameters: [
      { name: 'titleRaw', in: 'query', schema: { type: 'string' }, description: '每条原始 rdjb 的字符串原值，精确匹配；独立于来源查询 rdjb 范围，未知值保留，缺失不匹配。' },
      { name: 'view', in: 'query', schema: { type: 'string', enum: ['records', 'isolated'], default: 'records' } },
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '企业名称关键词或统一社会信用代码关键词；只通过已归属观察匹配。' },
      { name: 'enterpriseId', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'platformKey', in: 'query', schema: { type: 'string' }, description: '精确目录业务ID（platform_business_record.platform_key）；不跨接口、不按名称合并。isolated 视图下匹配原行编号，因为未投影观察没有目录业务ID。' },
      { name: 'rdjb', in: 'query', schema: { type: 'string', enum: ['1', '2', '3'] }, description: '来源查询的显式称号范围（1 创新型、2 专精特新、3 小巨人）；不是逐行称号事实。' },
      { name: 'rddqrq', in: 'query', schema: { type: 'string' }, description: '原 rddqrq（有效期原值），精确字符串相等；不解析日期、不按前缀/年份匹配。' },
      { name: 'whpcyear', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '来源显式有效维护年（正整数）；未知/缺省不匹配。' },
      { name: 'whpc', in: 'query', schema: { type: 'string' }, description: '原 whpc 维护批次值，精确字符串相等。' },
      { name: 'szq', in: 'query', schema: { type: 'string' }, description: '原 szq 属地值，精确字符串相等。' },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
    ],
    responses: {
      200: { description: 'rows[{kind:record,...}|{kind:observation,...}], total/page/pageSize/view。' },
      400: { description: '分页、ID、年份、view/rdjb 取值非法或出现未知查询参数。' },
    },
  },
})

export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  try {
    return listPlatformRecognizedDirectory(recognizedDirectoryFilterFromQuery(getQuery(event)), useDb())
  } catch (error) {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    throw createError({ statusCode: failure.statusCode ?? 500, statusMessage: failure.message ?? 'recognized directory query failed' })
  }
})
