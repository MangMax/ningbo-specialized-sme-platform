import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../utils/mcp-guard'
import { importReceiptMcpResult, readImportReceipt } from '../../utils/import-receipts'
export default defineMcpTool({ name: 'list_roster_import_items', title: '分页读取导入逐项结果', description: '等价 GET /api/roster/import/receipts/items。batchId、idempotencyKey 或 receiptId 三选一；pageSize 最大 50；只返回索引、ok、kind、ref、错误码/字段，不含 detail/请求。需 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { batchId: z.number().int().positive().optional(), idempotencyKey: z.string().min(1).max(4096).optional(), receiptId: z.number().int().positive().optional(), page: z.number().int().min(1).max(1000000).optional(), pageSize: z.number().int().min(1).max(50).optional() }, handler: input => importReceiptMcpResult(() => readImportReceipt(useDb(), 'items', input)) })
