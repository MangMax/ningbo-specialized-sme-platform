import { importItemsReadSchema, importItemsReadShape } from '../../utils/official-evidence-read'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../utils/mcp-guard'
import { ImportReceiptError, importReceiptMcpResult, readImportReceipt } from '../../utils/import-receipts'
export default defineMcpTool({ name: 'list_roster_import_items', title: '分页读取导入逐项结果', description: '等价 GET /api/roster/import/receipts/items。batchId、idempotencyKey 或 receiptId 三选一；pageSize 最大 50；只返回索引、ok、kind、ref、错误码/字段，不含 detail/请求。需 MCP token。可选 projection=snapshot|eventIds；source=private_batch+batchId 或 redacted_receipt+receiptId二选一，itemIndex/oldRecordId必需。snapshot不内嵌eventIds，后者用绑定selector的cursor分页20/50；maxBytes16384/65536，缺失不回退。projection=qualification独立读取当次announcement成功record_event的完整历史资格capture；同样精确互斥source与ID，itemIndex必需，不接受oldRecordId/idempotencyKey/page/pageSize/cursor。maxBytes为1..65536整数，默认65536；整个公开封套超限413且无partial，不从当前详情重建。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: importItemsReadShape, handler: input => importReceiptMcpResult(()=>{
  // SDK raw shapes validate fields, not selector combinations. Only known
  // optional undefined values are omitted; unknown extras must remain invalid.
  const args=Object.fromEntries(Object.entries(input).filter(([key,value])=>value!==undefined || !Object.hasOwn(importItemsReadShape,key)))
  const parsed=importItemsReadSchema.safeParse(args)
  if(!parsed.success) {
    if(Object.keys(args).some(key=>!Object.hasOwn(importItemsReadShape,key))) throw new ImportReceiptError(400,'invalid_query','Unsupported query field')
    if(args.projection===undefined && [args.batchId,args.receiptId,args.idempotencyKey].filter(value=>value!==undefined).length!==1)
      throw new ImportReceiptError(400,'invalid_query','Supply exactly one batchId, idempotencyKey or receiptId')
    throw new ImportReceiptError(400,'invalid_query','Invalid exact merge snapshot selector')
  }
  if(parsed.data.idempotencyKey!==undefined && !parsed.data.idempotencyKey.trim()) throw new ImportReceiptError(400,'invalid_query','Invalid idempotencyKey')
  return {content:[{type:'text' as const,text:JSON.stringify(readImportReceipt(useDb(),'items',parsed.data))}]}
}) })
