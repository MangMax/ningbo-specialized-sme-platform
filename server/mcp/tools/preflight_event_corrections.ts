import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { eventCorrectionRequestSchema } from '../../../layers/sme-roster/server/utils/roster-event-correction'
import { dispatchEventCorrectionMcp } from '../../../layers/sme-roster/server/utils/mcp-event-correction'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({ name: 'preflight_event_corrections', title: '预检正式事件原地更正', description: '等价 POST /api/roster/events/corrections/preflight。稳定事件/记录/企业 ID + expectedRevision；只更正事件字段，保留原出处。需 MCP token；先 get_official_event 核验出处与版本。', enabled: writeGuard, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: eventCorrectionRequestSchema.shape, handler: async args => dispatchEventCorrectionMcp('preflight', args, { db: useDb(), authorized: true }) })
