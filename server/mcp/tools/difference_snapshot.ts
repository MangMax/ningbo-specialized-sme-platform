import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { z } from 'zod'
import { snapshotOperation } from '../../utils/difference-snapshot'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'difference_snapshot', title: '公布名单归档快照任务',
  description: 'create 先备份并冻结全部公布企业；read 查询进度及归档摘要；retry 复用归档并逐企业补采缺口；保留分页断点与失败。',
  enabled: writeGuard,
  inputSchema: { action: z.enum(['create', 'read', 'retry']), clientRequestId: z.string().optional(), jobId: z.string().optional() },
  handler: async input => {
    const row = await snapshotOperation(useDb(), useRuntimeConfig().filesDir, input)
    return { content: [{ type: 'text' as const, text: JSON.stringify(row) }] }
  },
})
