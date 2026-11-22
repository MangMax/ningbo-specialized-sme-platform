import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { businessProcessFilterSchema } from '../../../lib/platform/business-processes'
import { listPlatformArchive } from '../../utils/platform-archive-read'

export default defineMcpTool({
  name: 'list_platform_business_processes',
  title: '本地查询关联办理记录',
  description:
    'titleRaw 按每条原始 rdjb 字符串原值精确筛选，独立于查询范围；返回 matchedVersion.titleRaw 或 isolated.titleRaw，缺失 null，未知原值保留。等价 GET /api/platform/business-processes。只读本地 business_list（businessList）typed 投影，不访问外部平台。view=records 按办理编号组织，按最近一次可核实采集的业务字段筛选，返回该次业务字段和历史证据计数、企业归属、观察到的明确称号范围与冲突；view=isolated 单独返回缺编号/编号冲突/原文无法核实且无法并入记录的观察。可按企业名称/统代关键词、企业ID、精确办理编号、来源查询的显式称号范围（rdjb 1/2/3，不是逐行称号事实）、事项（已知 申请/更新/复核 归一为 apply/update/review，字典外原值保留）、明确业务年、原 cszt、原 whpc 筛选并分页（最多200）。未知值与缺值不猜填，也不读取 raw JSON。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: businessProcessFilterSchema.shape,
  handler: async input => {
    const result = await listPlatformArchive('business-processes', input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
