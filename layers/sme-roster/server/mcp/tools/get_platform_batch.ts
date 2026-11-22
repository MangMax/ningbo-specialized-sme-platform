import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformBatchIdShape, platformBatchResultShape } from '../../../lib/platform/batch-query'
import { platformBatchRuntime } from '../../utils/platform-batch-runtime'
export default defineMcpTool({
  name: 'get_platform_batch', title: '读取平台批次状态、真实完成项进度、完整性和全部segments；failed/partial不是无记录；重启后不自动恢复',
  description: '读取平台批次状态、真实完成项进度、完整性和业务行及分页状态；failed/partial不是无记录；重启后不自动恢复。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: platformBatchIdShape, outputSchema: platformBatchResultShape,
  handler: async input => {
    const result = await platformBatchRuntime(useRuntimeConfig().filesDir).status(input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
