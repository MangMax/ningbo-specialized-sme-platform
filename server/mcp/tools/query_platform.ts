import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformQueryInputShape, platformQueryResultShape } from '../../../lib/platform/live-query'
import { runPlatformLiveQuery } from '../../utils/platform-live-query'
export default defineMcpTool({
  name: 'query_platform', title: '实时查询平台记录',
  description: '与 POST /api/platform/query 同义的只读查询，无需本库企业或 Cookie。name 关键词与 uscc 按 AND 组合。先用 get_platform_capabilities 查看来源能力；queryList支持name/uscc；businessList只支持uscc，必填rdjb=1/2/3/all（创新型/专精特新中小企业/小巨人/全三称号），拒绝名称。all从第一页查询，补查选unfinished的单称号。失败与 partial 不能当无记录；unfinished 给出补查页。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: platformQueryInputShape,
  outputSchema: platformQueryResultShape,
  handler: async input => {
    const result = await runPlatformLiveQuery(input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
