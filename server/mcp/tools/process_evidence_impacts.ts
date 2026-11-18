import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { processCommand114, work114 } from '../../../layers/sme-roster/server/utils/evidence-review-114'
import { parse102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102-output'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({ name: 'process_evidence_impacts', title: 'process_evidence_impacts', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: processCommand114.shape, handler: async input => decisionMcp102(useDb(), () => work114(useDb(), parse102(processCommand114, input)) ) })
