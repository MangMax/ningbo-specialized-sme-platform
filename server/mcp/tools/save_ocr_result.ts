import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape } from '../../utils/mcp-files'
import { writeGuard } from '../../utils/mcp-guard'
import { ocrNotEnabledError } from '../../utils/ocr-result'

/**
 * `save_ocr_result` —— 写回 OCR 结果(票 18 的**写入**之一,需鉴权)。
 *
 * **尚未启用**:依赖票 14 的 OCR 结果表,那张票还没做。按票 18 的要求把这个 tool
 * **留着并明确报错**(而不是删掉或现造一张表)。调用一律得到 501 + 一句说明。
 *
 * 保留了 `enabled: writeGuard` —— 它**是**写入 tool,所以即便当前只会 501,
 * 也不该出现在未鉴权客户端的 `tools/list` 里(否则等于告诉对方「这里有个写入口」)。
 *
 * `inputSchema` 照打算支持的形状声明,理由同 `get_ocr_result`。
 */
export default defineMcpTool({
  name: 'save_ocr_result',
  title: '写回 OCR 结果(尚未启用)',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)写回某页(或整份文件)的 OCR 结果 markdown。',
    '**尚未启用**:依赖票 14 的 OCR 结果表,当前调用一律返回 501 并说明原因。',
    '**是写入 tool**,需要鉴权(Authorization: Bearer <NUXT_MCP_TOKEN>)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    page: z.number().int().min(1).optional().describe('页号(OCR 结果按页挂)'),
    markdown: z.string().min(1).describe('OCR 结果,markdown 文本(带页码更能对上出处的页码)'),
  },
  handler: async () => {
    throw ocrNotEnabledError()
  },
})
