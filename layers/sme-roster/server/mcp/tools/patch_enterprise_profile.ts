import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { enterpriseProfilePatchSchema, patchEnterpriseProfile } from '../../utils/enterprise-profile'
export default defineMcpTool({
  name: 'patch_enterprise_profile', title: '原子更正企业资料并保留已确认旧名',
  description: '等价 PATCH /api/roster/enterprises/:id。先 get_enterprise_profile 取 version，原请求放 request。仅 name/city/district，省略不改、city/district:null 清空。更名需 previousName:{name:精确旧名,sameSubject:true}；不补统代、不改身份、不恢复已撤回别名。actor/basis、幂等键、预期版本必填。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  enabled: writeGuard,
  inputSchema: { enterpriseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), request: enterpriseProfilePatchSchema },
  handler: async ({ enterpriseId, request }) => patchEnterpriseProfile(useDb(), enterpriseId, request),
})
