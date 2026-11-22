import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { platformBatchInputShape, platformBatchReceiptShape } from '../../../lib/platform/batch-query'
import { platformBatchRuntime } from '../../utils/platform-batch-runtime'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { platformMcpLogContext } from '../../utils/mcp-platform-query'
export default defineMcpTool({
  name: 'submit_platform_batch', title: '异步提交平台批次',
  description: '异步提交平台批次。items[{query}]最多50；复用query_platform三来源条件；稳定batchId/itemId。任务保留结构化业务行、分页状态和时间。rawDataVersion 仅用于同步单查。需要MCP任务token；no Cookie。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  enabled: writeGuard,
  inputSchema: platformBatchInputShape, outputSchema: platformBatchReceiptShape,
  handler: async (input, extra) => {
    const result = await platformBatchRuntime(useRuntimeConfig().filesDir).submit(input, platformMcpLogContext(extra))
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
