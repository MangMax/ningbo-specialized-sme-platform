import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
import { importReceiptMcpResult, readImportReceipt } from '../../../layers/sme-roster/server/utils/import-receipts'
export default defineMcpTool({ name: 'get_roster_import_request', title: '按需分块读取脱敏导入请求', description: '等价 GET /api/roster/import/receipts/request。batchId、idempotencyKey 或 receiptId 三选一；offset 为字节偏移，maxBytes 默认 16384、最大 65536，data 为 base64，拼接字节后解码 UTF8。只读、不重新执行；旧批次未留原文会报 not_retained；需 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { batchId: z.number().int().positive().optional(), idempotencyKey: z.string().min(1).max(4096).optional(), receiptId: z.number().int().positive().optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional(), maxBytes: z.number().int().min(1).max(65536).optional() }, handler: input => importReceiptMcpResult(() => readImportReceipt(useDb(), 'request', input)) })
