import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence_source', title: '读取正式事件、接口行或导出行及反向对应', description: '应用错误返回 isError=true，content[0].text 为含 error.code/message 的 JSON；未知异常为 internal_error。等价 GET /api/roster/correspondences/{events|relations|export-rows}/:id。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { kind: z.enum(['event', 'relation', 'export_row']), id: z.number().int().positive() }, handler: async input => dispatchRecordCorrespondenceMcp('source', input) })
