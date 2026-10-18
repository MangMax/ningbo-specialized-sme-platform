import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { recordComparisonInput } from '~~/lib/roster/record-comparison'
import { previewRecordCorrespondenceImpact } from '../../utils/record-comparison'
export default defineMcpTool({ name: 'preview_record_correspondence_impact', title: '旧结论只读影响预览', description: '等价 GET /api/roster/record-comparison/legacy-impact；显示原 difference_reason IDs、可能类别、未解决与数据/模型问题，不写业务库或旧结论。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: recordComparisonInput.shape, handler: async input => previewRecordCorrespondenceImpact(useDb(), recordComparisonInput.parse(input)) })
