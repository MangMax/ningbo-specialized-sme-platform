import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { currentQualifiedFilterSchema } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../utils/enterprise-read'

export default defineMcpTool({
  name: 'list_current_qualified_enterprises',
  title: '查询当前有效称号企业',
  description: '与 GET /api/roster/current-enterprises 同语义：指定单一称号，当前授予事件及其已确认归档平台返回行上的条件按 AND 匹配；实际授予年份精度仅被日期闭区间完整包含时确定命中，部分重叠计 uncertainTotal。仅 observed innovative_sme 的 queryBusList schema 支持 date-only rddqrq→有效年、返回 whpcyear 为空时 YYYY-N 型 whpc 年份前缀→维护年；批次后缀、datetime、非空 whpcyear/plain batch、其他称号和格式均未知；查询谓词仅用于冲突校验，缺失或矛盾保持未知，不等于 dueYear。维护批次须附维护年份。返回完整确定匹配计数、选项和稳定分页；只读。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: currentQualifiedFilterSchema.shape,
  handler: async (input, extra) => {
    const result = await enterpriseReads.currentQualifiedJson(useDb().$client.name, currentQualifiedFilterSchema.parse(input), extra?.signal)
    return result.body.toString('utf8')
  },
})
