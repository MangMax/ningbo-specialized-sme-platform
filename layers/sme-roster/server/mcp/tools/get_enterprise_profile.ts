import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { getPostgresEnterpriseProfile } from '../../utils/enterprise-profile-postgres'
import { usePostgresDirectoryDb } from '../../../../../db/postgresql/client'
export default defineMcpTool({
  name: 'get_enterprise_profile', title: '读取企业可维护资料和版本',
  description: '等价 GET /api/roster/enterprises/:id/profile。轻量 name/city/district 和 expectedVersion，不加载平台原文。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { enterpriseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) },
  handler: async ({ enterpriseId }) => {
    const pg = usePostgresDirectoryDb()
    return getPostgresEnterpriseProfile(pg, enterpriseId)
  },
})
