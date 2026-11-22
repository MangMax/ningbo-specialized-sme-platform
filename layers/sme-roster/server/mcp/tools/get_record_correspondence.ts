import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence', title: '读取单条对应和具体来源', description: '应用错误返回 isError=true，content[0].text 为含 error.code/message 的 JSON；未知异常为 internal_error。等价 GET /api/roster/correspondences/:id。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive() }, handler: async input => dispatchRecordCorrespondenceMcp('get', input) })
