import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { impactPreview114, previewImpacts114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'preview_evidence_impacts', title: 'preview_evidence_impacts', description: '见 docs/evidence-review-contract-114.md；有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactPreview114.shape, handler: async input => decisionMcp102(useDb(), () => useDb().transaction(tx => previewImpacts114(useDb(), parse102(impactPreview114, input))) ) })
