import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { fileRefShape, requireFileRef, requirePostgresFileRef } from '../../utils/file-agent-reference'
import { readFileMaintenance } from '../../utils/file-maintenance'
import { readPostgresFileMaintenance } from '../../utils/file-maintenance-postgres'
import { usePostgresFileDb } from '../../utils/file-store-postgres'
export default defineMcpTool({
  name: 'get_file_maintenance', title: '读取文件维护修订与历史',
  description: '按文件 ID 或原路径精确读取文件维护状态及有界历史（包括已移出文件），与 GET /api/files/:id/maintenance 相同；pageSize 上限100。不扫描磁盘、不加载 OCR 或来源原文。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(100).optional() },
  handler: async input => {
    const pg = usePostgresFileDb()
    if (pg) {
      const file = await requirePostgresFileRef(pg, input, { allowRemoved: true })
      return readPostgresFileMaintenance(pg, file.id, input.page ?? 1, input.pageSize ?? 50)
    }
    const db = useDb()
    const file = requireFileRef(db, input, { allowRemoved: true })
    return readFileMaintenance(db, file.id, input.page, input.pageSize)
  },
})
