import { dispatchPostgresOfficialEvidenceMcp } from '../../utils/official-evidence-read-postgres'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchEventCorrectionMcp, isEventCorrectionMcpResult } from '../../utils/mcp-event-correction'
export default defineMcpTool({ name: 'get_event_correction_audit', title: '分页读取正式事件更正审计', description: '等价 GET /api/roster/events/:id/audit。稳定事件 ID；pageSize 1–100，默认50；返回修改前后、操作者、依据与原出处。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { eventId: z.number().int().positive(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(100).optional() }, handler: async args => {
  const native = await dispatchPostgresOfficialEvidenceMcp('event', 'audit', args)
  if (native === undefined) return dispatchEventCorrectionMcp('audit', args, { db: useDb() })
  if (!isEventCorrectionMcpResult(native)) throw Object.assign(new Error('Invalid event correction MCP result'), { code: 'internal_error', statusCode: 500 })
  return native
} })
