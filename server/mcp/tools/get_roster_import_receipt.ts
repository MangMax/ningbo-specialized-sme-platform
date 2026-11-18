import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
import { importReceiptMcpResult, readImportReceipt } from '../../utils/import-receipts'
export default defineMcpTool({ name: 'get_roster_import_receipt', title: '精确读取导入回执', description: '等价 GET /api/roster/import/receipts。batchId、idempotencyKey 或历史 receiptId 三选一。只读、不重试提交、不返回全部原文；需 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { batchId: z.number().int().positive().optional(), idempotencyKey: z.string().min(1).max(4096).optional(), receiptId: z.number().int().positive().optional() }, handler: input => importReceiptMcpResult(() => readImportReceipt(useDb(), 'get', input)) })
