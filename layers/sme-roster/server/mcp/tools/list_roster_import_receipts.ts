import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { readRuntimeImportReceipt } from '../../utils/import-receipts-runtime'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { asyncImportReceiptMcpResult } from '../../utils/import-receipts'
export default defineMcpTool({ name: 'list_roster_import_receipts', title: '分页读取导入回执历史', description: '等价 GET /api/roster/import/receipts/history。batchId 或 idempotencyKey 二选一；稳定按 receiptId 升序分页，pageSize 最大 50；需 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { batchId: z.number().int().positive().optional(), idempotencyKey: z.string().min(1).max(4096).optional(), page: z.number().int().min(1).max(1000000).optional(), pageSize: z.number().int().min(1).max(50).optional() }, handler: input => asyncImportReceiptMcpResult(() => readRuntimeImportReceipt('history', input)) })
