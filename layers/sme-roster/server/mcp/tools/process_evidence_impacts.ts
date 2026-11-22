import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { processCommand114 } from '../../utils/evidence-review-114-contract'
import { parse102 } from '../../utils/decision-lifecycle-102/contract'
import { decisionWriteMcp102 } from '../../utils/decision-lifecycle-102-output'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { workPostgresEvidenceReview } from '../../utils/evidence-review-work-postgres'
export default defineMcpTool({ name: 'process_evidence_impacts', title: 'process_evidence_impacts', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: processCommand114.shape, handler: async input => decisionWriteMcp102(db => workPostgresEvidenceReview(db, parse102(processCommand114, input))) })
