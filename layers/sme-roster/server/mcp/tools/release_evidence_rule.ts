import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { ruleCommand114, work114 } from '../../utils/evidence-review-114'
import { parse102 } from '../../utils/decision-lifecycle-102'
import { decisionWriteMcp102 } from '../../utils/decision-lifecycle-102-output'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { workPostgresEvidenceReview } from '../../utils/evidence-review-work-postgres'
export default defineMcpTool({ name: 'release_evidence_rule', title: 'release_evidence_rule', description: '有界复核，保留决定与历史；所有响应 no-store。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: ruleCommand114.shape, handler: async input => decisionWriteMcp102(useDb, db => work114(db, parse102(ruleCommand114, input)),
  db => workPostgresEvidenceReview(db, parse102(ruleCommand114, input))) })
