import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { impactSources114, listSources114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'list_evidence_impact_sources', title: 'list_evidence_impact_sources', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactSources114.shape, handler: async input => decisionMcp102(useDb(), () => useDb().transaction(tx => listSources114(useDb(), parse102(impactSources114, input))) ) })
