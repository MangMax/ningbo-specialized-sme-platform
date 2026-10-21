import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({
  name: 'list_record_correspondences', title: '分页读取记录对应与双向原行出处',
  description: '应用错误返回 isError=true，content[0].text 为含 error.code/message 的 JSON；未知异常为 internal_error。详见 docs/record-correspondence-mcp-errors.md。等价 GET /api/roster/correspondences。默认返回完整脱敏出处；view=summary 仅返回边摘要，按 ID 点读完整出处。读已归档行，不抓平台，不返回原始响应或凭据。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { eventId: z.number().int().positive().optional(), relationId: z.number().int().positive().optional(), exportRowId: z.number().int().positive().optional(), enterpriseId: z.number().int().positive().optional(), titleCode: z.string().optional(), type: z.enum(['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export']).optional(), role: z.string().optional(), status: z.enum(['candidate', 'confirmed', 'rejected', 'unlinked']).optional(), ruleVersion: z.string().optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(), view: z.literal('summary').optional() },
  handler: async input => dispatchRecordCorrespondenceMcp('list', input, { db: useDb() }),
})
