import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { getEnterpriseProfileHistory } from '../../utils/enterprise-profile'
import { getPostgresEnterpriseProfileHistory } from '../../utils/enterprise-profile-postgres'
import { usePostgresDirectoryDb } from '../../../../../db/postgresql/client'
export default defineMcpTool({
  name: 'get_enterprise_profile_history', title: '分页读取企业资料更正历史',
  description: '等价 GET /api/roster/enterprises/:id/profile-history；公开只读，actor/basis、前后资料、版本和旧名ID。不返回请求原文或幂等键。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { enterpriseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), page: z.number().int().min(1).max(10000).optional(), pageSize: z.number().int().min(1).max(100).optional() },
  handler: async ({ enterpriseId, ...paging }) => {
    const pg = usePostgresDirectoryDb()
    return pg ? getPostgresEnterpriseProfileHistory(pg, enterpriseId, paging) : getEnterpriseProfileHistory(useDb(), enterpriseId, paging)
  },
})
