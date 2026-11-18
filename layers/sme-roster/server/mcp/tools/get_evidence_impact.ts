import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { impactGet114, getImpact114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'get_evidence_impact', title: 'get_evidence_impact', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactGet114.shape, handler: async input => decisionMcp102(useDb(), () => useDb().transaction(tx => getImpact114(useDb(), parse102(impactGet114, input).id)) ) })
