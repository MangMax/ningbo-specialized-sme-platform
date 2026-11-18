import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
import { aliasDecisionInput, maintainEnterpriseAlias } from '../../../layers/sme-roster/server/utils/alias-maintenance'
export default defineMcpTool({
  name: 'maintain_enterprise_alias', title: '确认、更正或撤回企业别名',
  description: '等价PATCH /api/roster/enterprises/:id/aliases/:aliasId。必须显式action/expectedVersion/actor/basis/idempotencyKey。correct独占changes，null仅清除note/validFrom/validTo。confirm可恢复withdrawn同ID。源证据/主体校验与导入复用，409冲突无部分写入。withdraw退出有效搜索/匹配但保留历史和原档。需要MCP token。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard,
  inputSchema: { enterpriseId: z.number().int().positive(), aliasId: z.number().int().positive(), ...aliasDecisionInput },
  handler: async ({ enterpriseId, aliasId, ...input }) => maintainEnterpriseAlias(useDb(), enterpriseId, aliasId, input),
})
