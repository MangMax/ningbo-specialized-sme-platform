import { usePostgresDirectoryDb } from '../../../../../db/postgresql/client'
import { listPostgresEnterpriseAliases } from '../../utils/alias-maintenance-postgres'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { aliasListInput } from '../../utils/alias-maintenance-model'
export default defineMcpTool({
  name: 'list_enterprise_aliases', title: '有界查询企业别名',
  description: '等价GET /api/roster/enterprises/:id/aliases。按稳定企业ID和all/pending/confirmed/withdrawn查询，pageSize最多50，保留原名称和来源引用，无原档。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { enterpriseId: z.number().int().positive(), ...aliasListInput },
  handler: async ({ enterpriseId, ...input }) => {
    const pg = usePostgresDirectoryDb()
    return listPostgresEnterpriseAliases(pg, enterpriseId, input)
  },
})
