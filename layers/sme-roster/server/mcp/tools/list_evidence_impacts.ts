import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { impactList114, listImpacts114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'list_evidence_impacts', title: 'list_evidence_impacts', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactList114.shape, handler: async input => decisionMcp102(useDb(), () => useDb().transaction(tx => listImpacts114(useDb(), parse102(impactList114, input))) ) })
