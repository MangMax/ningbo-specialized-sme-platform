import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { impactSources114 } from '../../utils/evidence-review-114-contract'
import { parse102 } from '../../utils/decision-lifecycle-102/contract'
import { decisionReadMcp102 } from '../../utils/decision-lifecycle-102-output'
import { listPostgresImpactSources114 } from '../../utils/evidence-review-reads-postgres'
export default defineMcpTool({ name: 'list_evidence_impact_sources', title: 'list_evidence_impact_sources', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactSources114.shape, handler: async input => decisionReadMcp102(db => listPostgresImpactSources114(db, parse102(impactSources114, input))) })
