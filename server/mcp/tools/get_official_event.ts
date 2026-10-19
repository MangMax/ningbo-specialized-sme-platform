import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchEventCorrectionMcp } from '../../utils/mcp-event-correction'
export default defineMcpTool({ name: 'get_official_event', title: '读取正式事件与版本出处', description: '等价 GET /api/roster/events/:id。精确读取 event、record、原 evidence、文件哈希与现有生命周期；不加载平台原文。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { eventId: z.number().int().positive() }, handler: async args => dispatchEventCorrectionMcp('get', args, { db: useDb() }) })
