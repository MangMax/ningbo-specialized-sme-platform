import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../utils/mcp-guard'
import { dispatchRecordCorrespondenceMcp } from '../../utils/mcp-record-correspondence'
export default defineMcpTool({ name: 'save_record_correspondences', title: '原子提交对应决定', description: '应用错误返回 isError=true，content[0].text 为含 error.code/message 的 JSON；未知异常为 internal_error。详见 docs/record-correspondence-mcp-errors.md。等价 POST /api/roster/correspondences/commit；传原预检 request 和 planHash。确认候选不得绕过核心。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { request: z.record(z.string(), z.unknown()), planHash: z.string().length(64) }, handler: async input => dispatchRecordCorrespondenceMcp('commit', input, { db: useDb(), authorized: true }) })
