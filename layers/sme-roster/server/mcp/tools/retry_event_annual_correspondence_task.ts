import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { JOB_ID_RE } from '../../../../core/lib/job'
import { annualTaskContext } from '../../utils/annual-correspondence-read'
import { annualTaskMcpRequest } from '../../utils/annual-correspondence-mcp'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
export default defineMcpTool({
  name: 'retry_event_annual_correspondence_task',
  title: '恢复年度对应任务',
  description: '显式eventIds最多200；同键绑定冻结输入、服务端按来源代次去重；保留业务检查点、人工决定与实际观察来源。GET零写并动态复验最终资格。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  enabled: writeGuard,
  inputSchema: { id: z.string().regex(JOB_ID_RE) },
  handler: async (input, extra) => {
    const context = annualTaskContext()
    return annualTaskMcpRequest('retry', input, extra, { get db() { return context.db }, readScope: context.readScope, filesDir: context.filesDir, mcpToken: useRuntimeConfig().mcpToken })
  },
})
