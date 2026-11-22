import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { recognizedDirectoryFilterSchema } from '../../../lib/platform/recognized-directory'
import { listPlatformArchive } from '../../utils/platform-archive-read'

export default defineMcpTool({
  name: 'list_platform_recognized_directory',
  title: '本地查询平台认定目录（镜像）',
  description:
    'titleRaw 按每条原始 rdjb 字符串原值精确筛选，独立于查询范围；返回 matchedVersion.titleRaw 或 isolated.titleRaw，缺失 null，未知原值保留。等价 GET /api/platform/recognized-directory。只读本地 recognized_list（queryBusList，平台认定目录）typed 投影，不访问外部平台。这是平台认定目录镜像，不是「当前有效企业」资格模型：目录存在/消失或日期原值都不推出正式有效或失效。view=records 按目录业务ID组织，按最近一次可核实采集的业务字段筛选，返回该次业务字段和历史证据计数、企业归属、观察到的明确称号范围与冲突；view=isolated 单独返回缺编号/编号冲突/原文无法核实且无法并入记录的观察。可按企业名称/统代关键词、企业ID、精确目录业务ID、来源查询的显式称号范围（rdjb 1/2/3，不是逐行称号事实）、原有效期 rddqrq（精确字符串，不解析日期）、显式正整数 whpcyear、原 whpc、原 szq 筛选并分页（最多200）。未知值与缺值不猜填，也不读取 raw JSON。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: recognizedDirectoryFilterSchema.shape,
  handler: async input => {
    const result = await listPlatformArchive('recognized-directory', input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
