import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { preflightQualification102, qualificationPreflight102 } from '../../utils/decision-lifecycle-102'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { decisionWriteMcp102 } from '../../utils/decision-lifecycle-102-output'
import { preflightPostgresQualification102 } from '../../utils/decision-lifecycle-102/postgres-writes'
export default defineMcpTool({ name: 'preflight_qualification_decision', title: '迁入资格preflight', description: '等价 POST /api/roster/decision-lifecycle/qualification-preflight；仅有 currentQualification 的 replace；来源、事实和 head 版本绑定。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: qualificationPreflight102.shape, handler: async input => decisionWriteMcp102(useDb, db => preflightQualification102(db, input),
  db => preflightPostgresQualification102(db, input), false) })
