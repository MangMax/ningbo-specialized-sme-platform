import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { evidenceCorrectionRequestSchema } from '../../utils/roster-evidence-correction-model'
import { dispatchEvidenceCorrectionMcp } from '../../utils/mcp-roster-evidence-correction'
export default defineMcpTool({ name: 'commit_roster_evidence_corrections', title: '原子提交正式出处精确更正', description: '等价POST /api/roster/evidence/corrections/commit。原request+planHash，幂等、全批原子、追加审计。保留证据/事件ID和原文件字节；关联对应动态待重核。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { request: evidenceCorrectionRequestSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }, handler: async input => dispatchEvidenceCorrectionMcp('commit', input, { filesDir: useRuntimeConfig().filesDir, authorized: true }) })
