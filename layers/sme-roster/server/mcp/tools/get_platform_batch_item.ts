import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { platformBatchItemShape, platformBatchItemResultShape } from '../../../lib/platform/batch-query'
import { getPlatformBatchItem } from '../../utils/platform-batch-query'
export default defineMcpTool({
  name: 'get_platform_batch_item', title: '按batchId和稳定itemId读取本项全部原始关系、原查询时间和unfinished',
  description: '按batchId和稳定itemId读取本项全部原始关系、原查询时间和unfinished。逐页来源见segments；不按代码去重。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: platformBatchItemShape, outputSchema: platformBatchItemResultShape,
  handler: async input => {
    const result = getPlatformBatchItem(useDb(), input)
    return { structuredContent: { ...result }, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  },
})
