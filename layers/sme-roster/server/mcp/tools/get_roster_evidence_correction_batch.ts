import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { dispatchEvidenceCorrectionMcp } from '../../utils/mcp-roster-evidence-correction'
export default defineMcpTool({ name: 'get_roster_evidence_correction_batch', title: '恢复出处更正回执', description: '等价GET /api/roster/evidence/corrections/batches/:key。按幂等键精确恢复，需MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { idempotencyKey: z.string().trim().min(1).max(200) }, handler: async input => dispatchEvidenceCorrectionMcp('batch', input, { db: useDb(), authorized: true }) })
