import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { declarationFilterSchema } from '../../../lib/platform/declarations'
import { listPlatformDeclarations } from '../../utils/platform-declarations'

export default defineMcpTool({
  name: 'list_platform_declarations',
  title: '本地查询申报记录',
  description:
    '等价 GET /api/platform/declarations。只读本地 apply_list（queryList）typed 投影，不访问外部平台。view=records 按业务编号组织，返回匹配内容版本、全部版本/观察计数、企业归属与冲突；view=isolated 单独返回缺编号/编号冲突/原文不可核实且无法并入记录的观察。可按企业名称/统代关键词、企业ID、精确申报编号、原 sblx、明确年份、原 cszt 筛选并分页（最多200）。未知值与缺值不猜填，也不读取 raw JSON。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: declarationFilterSchema.shape,
  handler: async input => ({ ...listPlatformDeclarations(input, useDb()) }),
})
