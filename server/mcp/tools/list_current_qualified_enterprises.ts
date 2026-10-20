import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { currentQualifiedFilterSchema } from '../../utils/current-qualified-filter'
import { enterpriseReads } from '../../utils/enterprise-read'

export default defineMcpTool({
  name: 'list_current_qualified_enterprises',
  title: '查询当前有效称号企业',
  description: '与 GET /api/roster/current-enterprises 同语义：指定单一称号，完整 eligible 计数和稳定分页；q 匹配现名、已确认曾用名或统代，district 与 q 同时生效。只读，不需要 token；来源与资格依据见返回行及企业详情。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: currentQualifiedFilterSchema.shape,
  handler: async (input, extra) => {
    const result = await enterpriseReads.currentQualifiedJson(useDb().$client.name, currentQualifiedFilterSchema.parse(input), extra?.signal)
    return result.body.toString('utf8')
  },
})
