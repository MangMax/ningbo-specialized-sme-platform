import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { eventCorrectionRequestSchema } from '../../utils/roster-event-correction'
import { dispatchEventCorrectionMcp } from '../../utils/mcp-event-correction'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({ name: 'commit_event_corrections', title: '原子提交正式事件更正', description: '等价 POST /api/roster/events/corrections/commit。传原 request 与 planHash；保留稳定 ID/全部出处，追加审计，更正后相关对应需重核。', enabled: writeGuard, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { request: eventCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }, handler: async args => dispatchEventCorrectionMcp('commit', args, { db: useDb(), authorized: true }) })
