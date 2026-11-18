import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRecordCorrespondenceMcp } from '../../../layers/sme-roster/server/utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence_audit', title: '读取对应追加审计', description: '应用错误返回 isError=true，content[0].text 为含 error.code/message 的 JSON；未知异常为 internal_error。等价 GET /api/roster/correspondences/:id/audit。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional() }, handler: async input => dispatchRecordCorrespondenceMcp('audit', input, { get db() { return useDb() } }) })
