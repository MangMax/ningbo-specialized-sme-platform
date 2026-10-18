import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../utils/mcp-guard'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'preflight_record_correspondences', title: '绑定对应决定的预检计划', description: '等价 POST /api/roster/correspondences/preflight。写计划账本，需 MCP token；最终决定仍由 #65 core 验证。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { idempotencyKey: z.string().min(1), sourceIdentity: z.string().min(1), actor: z.object({ type: z.enum(['user', 'agent']), id: z.string().min(1) }), basis: z.string().min(1), ruleId: z.string().min(1), ruleVersion: z.string().min(1), operations: z.array(z.record(z.string(), z.unknown())).min(1) }, handler: async input => dispatchRecordCorrespondenceMcp('preflight', input, { db: useDb(), authorized: true }) })
