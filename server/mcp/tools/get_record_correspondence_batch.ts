import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../utils/mcp-guard'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence_batch', title: '按原幂等键恢复对应回执', description: '等价 GET /api/roster/correspondences/batches/:idempotencyKey。需 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { idempotencyKey: z.string().min(1) }, handler: async input => dispatchRecordCorrespondenceMcp('batch', input, { db: useDb(), authorized: true }) })
