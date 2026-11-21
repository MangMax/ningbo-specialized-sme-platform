import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { impactPreview114, previewImpacts114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../utils/decision-lifecycle-102'
import { decisionReadMcp102 } from '../../utils/decision-lifecycle-102-output'
import { previewPostgresImpacts114 } from '../../utils/evidence-review-reads-postgres'
export default defineMcpTool({ name: 'preview_evidence_impacts', title: 'preview_evidence_impacts', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: impactPreview114.shape, handler: async input => decisionReadMcp102(useDb, db => previewImpacts114(db, parse102(impactPreview114, input)),
  db => previewPostgresImpacts114(db, parse102(impactPreview114, input))) })
