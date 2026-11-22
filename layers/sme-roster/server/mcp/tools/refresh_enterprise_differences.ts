import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { enterpriseDifferenceRefreshInput } from '../../utils/enterprise-difference-refresh-contract'
import { refreshPostgresEnterpriseDifferences } from '../../utils/enterprise-difference-refresh-postgres'
import { usePostgresRosterDb } from '../../utils/postgres-roster-db'
export default defineMcpTool({name:'refresh_enterprise_differences',title:'刷新企业差异比较',description:'等价 POST /api/roster/differences/refresh。可选不重复 enterpriseIds，省略全部公布企业。仅用已入库业务记录复用平台比较；默认待核，不自动确认无差异，不编排代理，不改变有效资格或旧历史。',enabled:writeGuard,inputSchema:enterpriseDifferenceRefreshInput.shape,handler: async input => {
  const postgres = usePostgresRosterDb(true)
  const result = await refreshPostgresEnterpriseDifferences(postgres, input)
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
}})
