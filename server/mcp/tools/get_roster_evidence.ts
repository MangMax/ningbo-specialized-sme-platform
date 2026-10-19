import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchEvidenceCorrectionMcp } from '../../utils/mcp-roster-evidence-correction'
export default defineMcpTool({ name: 'get_roster_evidence', title: '按证据ID读取正式出处', description: '等价GET /api/roster/evidence/:id。精确坐标、所属事件/记录/企业、文件身份、version和来源跳转；无原文blob。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive() }, handler: async input => dispatchEvidenceCorrectionMcp('get', input, { db: useDb() }) })
