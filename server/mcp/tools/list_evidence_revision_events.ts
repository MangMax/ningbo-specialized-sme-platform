import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { impactEvents114, listEvents114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'list_evidence_revision_events', title: 'list_evidence_revision_events', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactEvents114.shape, handler: async input => decisionMcp102(useDb(), () => useDb().transaction(tx => listEvents114(useDb(), parse102(impactEvents114, input))) ) })
