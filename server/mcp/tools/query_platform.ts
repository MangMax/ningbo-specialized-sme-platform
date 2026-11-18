import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformQueryInputShape, platformQueryResultShape } from '../../../layers/sme-roster/lib/platform/live-query'
import { runPlatformLiveQuery } from '../../../layers/sme-roster/server/utils/platform-live-query'
import { platformMcpLogContext } from '../../../layers/sme-roster/server/utils/mcp-platform-query'
export default defineMcpTool({
  name: 'query_platform', title: '实时查询平台记录',
  description: '显式传rawDataVersion:1才返回rawData.version=1的typed原行和实际接受页原响应；旧rows仍是字符串投影。原文敏感或超预算整页拒收；rawData.version=1 的 typed 原行已是 relation.rawFields 与业务内容版本的输入（#327）。与 POST /api/platform/query 同义的只读查询，无需本库企业或 Cookie。name 关键词与 uscc 按 AND 组合。先用 get_platform_capabilities 查看来源能力；当前支持 queryList、businessList、queryBusList。businessList只接受uscc和必填字符串rdjb=1/2/3/all，禁止name及已认定来源筛选；all从第一页开始，续查用unfinished的单称号字符串。queryBusList 的 rdjb 为1/2/3数组（默认全三称号）；sqsj=YYYY/MM/DD - YYYY/MM/DD，rddqrq为有效年份，whpcyear为维护年份，whpc=1–15且必须带whpcyear；szq是账号范围8位筛选码（不同于行szq）。仅qymc+asc/desc排序已验证；日期边界和时区未知。失败与 partial 不能当无记录；unfinished 给出补查页。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: platformQueryInputShape,
  outputSchema: platformQueryResultShape,
  handler: async (input, extra) => {
    const result = await runPlatformLiveQuery(input, { logContext: platformMcpLogContext(extra) })
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
