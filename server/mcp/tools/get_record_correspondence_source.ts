import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence_source', title: '读取正式事件、接口行或导出行及反向对应', description: '等价 GET /api/roster/correspondences/{events|relations|export-rows}/:id。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { kind: z.enum(['event', 'relation', 'export_row']), id: z.number().int().positive() }, handler: async input => dispatchRecordCorrespondenceMcp('source', input, { db: useDb() }) })
