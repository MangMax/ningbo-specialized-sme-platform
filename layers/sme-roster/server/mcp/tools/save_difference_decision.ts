import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { decisionCommand102, parse102, saveDecision102 } from '../../utils/decision-lifecycle-102'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { decisionWriteMcp102 } from '../../utils/decision-lifecycle-102-output'
import { savePostgresDecision102 } from '../../utils/decision-lifecycle-102/postgres-writes'
export default defineMcpTool({ name: 'save_difference_decision', title: '追加差异决定', description: '等价 POST /api/roster/decision-lifecycle/commands；显式 actor/basis/ruleVersion/effectiveAt/expectedCurrentId/idempotencyKey；', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: decisionCommand102.shape, handler: async input => decisionWriteMcp102(useDb, db => saveDecision102(db, parse102(decisionCommand102, input)),
  db => savePostgresDecision102(db, parse102(decisionCommand102, input))) })
