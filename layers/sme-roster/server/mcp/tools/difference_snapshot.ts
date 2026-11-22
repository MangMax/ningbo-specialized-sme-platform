import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { z } from 'zod'
import { snapshotRuntimeOperation } from '../../utils/difference-snapshot'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
export default defineMcpTool({
  name: 'difference_snapshot', title: '公布企业业务采集任务',
  description: 'create 先备份并冻结选定 enterpriseIds（可选1..200项，不传为全部）公布企业；read 查询进度及归档摘要；每个新任务逐企业新查三个接口；相同 clientRequestId 幂等返回原任务；retry 仅复用同一任务成功页续跑，历史归档不证明当前完成；保留分页断点与失败；按接口原编号复用业务记录，新增内容版本；保存所有业务字段，不保存HTML或请求/响应原文。',
  enabled: writeGuard,
  inputSchema: { action: z.enum(['create', 'read', 'retry']), clientRequestId: z.string().optional(), jobId: z.string().optional(), enterpriseIds: z.array(z.number().int().positive()).min(1).max(200).optional() },
  handler: async input => {
    const row = await snapshotRuntimeOperation(useRuntimeConfig().filesDir, input)
    return { content: [{ type: 'text' as const, text: JSON.stringify(row) }] }
  },
})
