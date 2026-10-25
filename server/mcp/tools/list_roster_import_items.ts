import { importItemsReadShape } from '../../utils/official-evidence-read'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../utils/mcp-guard'
import { importReceiptMcpResult, readImportReceipt } from '../../utils/import-receipts'
export default defineMcpTool({ name: 'list_roster_import_items', title: '分页读取导入逐项结果', description: '等价 GET /api/roster/import/receipts/items。batchId、idempotencyKey 或 receiptId 三选一；pageSize 最大 50；只返回索引、ok、kind、ref、错误码/字段，不含 detail/请求。需 MCP token。可选 projection=snapshot|eventIds；source=private_batch+batchId 或 redacted_receipt+receiptId二选一，itemIndex/oldRecordId必需。snapshot不内嵌eventIds，后者用绑定selector的cursor分页20/50；maxBytes16384/65536，缺失不回退。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: importItemsReadShape, handler: input => importReceiptMcpResult(()=>({content:[{type:'text' as const,text:JSON.stringify(readImportReceipt(useDb(),'items',input))}]})) })
