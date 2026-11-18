import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
import { dispatchRecordCorrespondenceMcp } from '../../../layers/sme-roster/server/utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence_batch', title: '按原幂等键恢复对应回执', description: '应用错误返回 isError=true，content[0].text 为含 error.code/message 的 JSON；未知异常为 internal_error。等价 GET /api/roster/correspondences/batches/:idempotencyKey。需 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { idempotencyKey: z.string().min(1) }, handler: async input => dispatchRecordCorrespondenceMcp('batch', input, { get db() { return useDb() }, authorized: true }) })
