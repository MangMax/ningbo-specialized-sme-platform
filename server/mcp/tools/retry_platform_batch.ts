import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { platformBatchRetryShape, platformBatchReceiptShape } from '../../../lib/platform/batch-query'
import { retryPlatformBatch } from '../../utils/platform-batch-query'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'retry_platform_batch', title: '显式补查itemIds指定未完成项/页，保留batchId/itemId和所有已完成行/查询时间',
  description: '显式补查itemIds指定未完成项/页，保留batchId/itemId和所有已完成行/查询时间。需要MCP任务token；重试最多10次执行，凭据在本次提交时重新快照；不自动重试认证失败。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  enabled: writeGuard,
  inputSchema: platformBatchRetryShape, outputSchema: platformBatchReceiptShape,
  handler: async input => {
    const result = retryPlatformBatch(useDb(), input, useRuntimeConfig().filesDir)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
