import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformQueryInputShape, platformQueryResultShape } from '../../../lib/platform/live-query'
import { runPlatformLiveQuery } from '../../utils/platform-live-query'
export default defineMcpTool({
  name: 'query_platform', title: '实时查询平台记录',
  description: '与 POST /api/platform/query 同义的只读查询，无需本库企业或 Cookie。name 关键词与 uscc 按 AND 组合。先用 get_platform_capabilities 查看来源能力；当前支持 queryList、queryBusList。queryBusList 的 rdjb 为1/2/3数组（默认全三称号）；sqsj=YYYY/MM/DD - YYYY/MM/DD，rddqrq为有效年份，whpcyear为维护年份，whpc=1–15且必须带whpcyear；szq是账号范围8位筛选码（不同于行szq）。仅qymc+asc/desc排序已验证；日期边界和时区未知。失败与 partial 不能当无记录；unfinished 给出补查页。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: platformQueryInputShape,
  outputSchema: platformQueryResultShape,
  handler: async input => {
    const result = await runPlatformLiveQuery(input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
