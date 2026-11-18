import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { fileRefShape, requireFileRef } from '../../../../../server/utils/mcp-files'
import { readFileMaintenance } from '../../utils/file-maintenance'
export default defineMcpTool({
  name: 'get_file_maintenance', title: '读取文件维护修订与历史',
  description: '按文件 ID 或原路径精确读取文件维护状态及有界历史（包括已移出文件），与 GET /api/files/:id/maintenance 相同；pageSize 上限100。不扫描磁盘、不加载 OCR 或来源原文。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(100).optional() },
  handler: input => { const db = useDb(); const file = requireFileRef(db, input, { allowRemoved: true }); return readFileMaintenance(db, file.id, input.page, input.pageSize) },
})
