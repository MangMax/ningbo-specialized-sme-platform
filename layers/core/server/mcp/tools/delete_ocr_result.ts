import type { LogContext } from '../../../lib/logging'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape } from '../../utils/file-agent-reference'
import { openOcrFileStore } from '../../utils/ocr-files'
import { writeGuard } from '../../utils/mcp-guard'
import { requireOcrFileRef, ocrPageSchema, ocrExpectedVersionSchema } from '../../utils/ocr-page-lifecycle'
import { deleteOcrPage } from '../../utils/ocr-result'

export default defineMcpTool({
  name: 'delete_ocr_result',
  title: '删除一页 OCR 结果',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  enabled: writeGuard,
  description: '按 fileId 或 relPath 与必填 page 删除一页派生 OCR。不存在页幂等返回 deleted:0；只删 OCR，不动页图、文件、正式事件或证据。expectedVersion 取读回页版本,不符拒绝为 409;必须提供版本;null 表示预期不存在,缺失返回参数错误。需要 MCP token。',
  inputSchema: { ...fileRefShape, page: ocrPageSchema, expectedVersion: ocrExpectedVersionSchema.nonoptional().describe('必填读回版本;null=预期不存在;不符409,缺失不降级盲删') },
  handler: async (input, extra) => {
    const { db } = await openOcrFileStore()
    const row = requireOcrFileRef(db, input)
    const out = deleteOcrPage(db, row.id, input.page, input.expectedVersion, (extra as { logContext?: LogContext } | undefined)?.logContext)
    if (!out.ok) throw createError({ statusCode: out.statusCode, message: out.message })
    return { file: { id: row.id, relPath: row.relPath, filename: row.filename }, page: input.page, deleted: out.deleted, remaining: out.remaining }
  },
})
