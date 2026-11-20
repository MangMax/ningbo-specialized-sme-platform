import { dispatchPostgresOfficialEvidenceMcp } from '../../utils/official-evidence-read-postgres'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchEvidenceCorrectionMcp } from '../../utils/mcp-roster-evidence-correction'
export default defineMcpTool({ name: 'get_roster_evidence_audit', title: '分页读取出处更正审计', description: '等价GET /api/roster/evidence/:id/audit。默认50条、最大200，含actor/basis/时间/前后坐标及文件身份。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive(), page: z.number().int().positive().max(1000000).optional(), pageSize: z.number().int().positive().max(200).optional() }, handler: async input => await dispatchPostgresOfficialEvidenceMcp('evidence', 'audit', input) ?? await dispatchEvidenceCorrectionMcp('audit', input, { db: useDb() }) })
