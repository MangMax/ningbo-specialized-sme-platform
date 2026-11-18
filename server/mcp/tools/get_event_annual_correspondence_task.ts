import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { JOB_ID_RE } from '../../../layers/core/lib/job'
import { annualTaskContext } from '../../../layers/sme-roster/server/utils/annual-correspondence-read'
import { annualTaskMcpRequest } from '../../../layers/sme-roster/server/utils/annual-correspondence-mcp'
export default defineMcpTool({
  name: 'get_event_annual_correspondence_task',
  title: '读取年度对应任务',
  description: '显式eventIds最多200；同键绑定冻结输入、服务端按来源代次去重；保留业务检查点、人工决定与实际观察来源。GET零写并动态复验最终资格。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { id: z.string().regex(JOB_ID_RE) },
  handler: async (input, extra) => {
    const context = annualTaskContext()
    return annualTaskMcpRequest('detail', input, extra, { get db() { return context.db }, readScope: context.readScope, filesDir: context.filesDir, mcpToken: useRuntimeConfig().mcpToken })
  },
})
