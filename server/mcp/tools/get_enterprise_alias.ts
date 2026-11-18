import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { getEnterpriseAlias } from '../../../layers/sme-roster/server/utils/alias-maintenance'
export default defineMcpTool({
  name: 'get_enterprise_alias', title: '精确读取企业别名', description: '等价GET /api/roster/enterprises/:id/aliases/:aliasId。精确目标，包括version、原名称与原来源；404不猜归属。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { enterpriseId: z.number().int().positive(), aliasId: z.number().int().positive() },
  handler: async ({ enterpriseId, aliasId }) => getEnterpriseAlias(useDb(), enterpriseId, aliasId),
})
