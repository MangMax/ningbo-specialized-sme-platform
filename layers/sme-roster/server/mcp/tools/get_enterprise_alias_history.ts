import { usePostgresDirectoryDb } from '../../../../../db/postgresql/client'
import { getPostgresEnterpriseAliasHistory } from '../../utils/alias-maintenance-postgres'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { aliasPageInput } from '../../utils/alias-maintenance-model'
export default defineMcpTool({
  name: 'get_enterprise_alias_history', title: '精确读取别名追加历史', description: '等价GET /api/roster/enterprises/:id/aliases/:aliasId/history。只读，按审计ID升序，pageSize最多50。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { enterpriseId: z.number().int().positive(), aliasId: z.number().int().positive(), ...aliasPageInput },
  handler: async ({ enterpriseId, aliasId, ...input }) => {
    const pg = usePostgresDirectoryDb()
    return getPostgresEnterpriseAliasHistory(pg, enterpriseId, aliasId, input)
  },
})
