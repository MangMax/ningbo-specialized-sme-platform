import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { recordComparisonInput } from '~~/lib/roster/record-comparison'
import { getRecordComparison } from '../../utils/record-comparison'
export default defineMcpTool({ name: 'list_record_comparison', title: '记录级对比', description: '等价 GET /api/roster/record-comparison；显式归档来源 ID 集，逐正式事件分类，保留所有来源行和版本/覆盖未知资格。只读。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: recordComparisonInput.shape, handler: async input => getRecordComparison(useDb(), recordComparisonInput.parse(input)) })
