import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchEventCorrectionMcp } from '../../utils/mcp-event-correction'
export default defineMcpTool({ name: 'get_event_correction_audit', title: '分页读取正式事件更正审计', description: '等价 GET /api/roster/events/:id/audit。稳定事件 ID；pageSize 1–100，默认50；返回修改前后、操作者、依据与原出处。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { eventId: z.number().int().positive(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(100).optional() }, handler: async args => dispatchEventCorrectionMcp('audit', args, { db: useDb() }) })
