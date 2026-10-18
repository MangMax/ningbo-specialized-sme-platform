import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformQueryInputShape, platformQueryResultShape } from '../../../lib/platform/live-query'
import { runPlatformLiveQuery } from '../../utils/platform-live-query'
export default defineMcpTool({
  name: 'query_platform', title: '实时查询平台记录',
  description: '与 POST /api/platform/query 同义的只读查询，无需本库企业或 Cookie。name 关键词与 uscc 按 AND 组合。先用 get_platform_capabilities 查看来源能力；当前仅 queryList。失败与 partial 不能当无记录；unfinished 给出补查页。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: platformQueryInputShape,
  outputSchema: platformQueryResultShape,
  handler: async input => {
    const result = await runPlatformLiveQuery(input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
