import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { enterpriseDifferenceRefreshInput, readEnterpriseDifferenceComparisons } from '../../utils/enterprise-difference-refresh'
export default defineMcpTool({name:'list_enterprise_difference_comparisons',title:'读取企业当前差异比较',description:'等价 GET /api/roster/differences/refresh。读取企业×称号当前比较及较新差异判断，供代理自行筛选；只读，不采集、不编排代理。',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:enterpriseDifferenceRefreshInput.shape,handler:async input=>({content:[{type:'text' as const,text:JSON.stringify(readEnterpriseDifferenceComparisons(useDb(),input))}]})})
