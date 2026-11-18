import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformQueryCapabilities } from '../../../layers/sme-roster/lib/platform/live-query'
export default defineMcpTool({ name: 'get_platform_capabilities', title: '平台实时查询能力', description: '发现逐来源可用性、条件、称号能力及全局请求上限。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, handler: async () => platformQueryCapabilities })
