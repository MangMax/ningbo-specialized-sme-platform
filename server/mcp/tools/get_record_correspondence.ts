import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'get_record_correspondence', title: '读取单条对应和具体来源', description: '等价 GET /api/roster/correspondences/:id。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive() }, handler: async input => dispatchRecordCorrespondenceMcp('get', input, { db: useDb() }) })
