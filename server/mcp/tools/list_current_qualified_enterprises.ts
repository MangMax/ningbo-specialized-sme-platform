import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { currentQualifiedFilterSchema } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../utils/enterprise-read'

export default defineMcpTool({
  name: 'list_current_qualified_enterprises',
  title: '查询当前有效称号企业',
  description: '与 GET /api/roster/current-enterprises 同语义：指定单一称号，当前周期同一认定事件及其已确认归档平台来源行上的筛选条件按 AND 匹配；认定年份精度仅被日期闭区间完整包含时确定命中，部分重叠计 uncertainTotal。有效年份与维护年批次来自成功完整 queryBusList 归档条件的来源行匹配证据，不等于 dueYear，也不推断原字段。维护批次须附维护年份。返回完整确定匹配计数、选项和稳定分页；只读。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: currentQualifiedFilterSchema.shape,
  handler: async (input, extra) => {
    const result = await enterpriseReads.currentQualifiedJson(useDb().$client.name, currentQualifiedFilterSchema.parse(input), extra?.signal)
    return result.body.toString('utf8')
  },
})
