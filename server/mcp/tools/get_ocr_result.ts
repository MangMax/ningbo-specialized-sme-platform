import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape } from '../../utils/mcp-files'
import { ocrNotEnabledError } from '../../utils/ocr-result'

/**
 * `get_ocr_result` —— 取某文件/某页的 OCR 结果(markdown,带页码)。
 *
 * **尚未启用**:依赖票 14 的 OCR 结果表,那张票还没做。按票 18 的要求把这个 tool
 * **留着并明确报错**(而不是删掉或现造一张表)。调用一律得到 501 + 一句说明。
 *
 * 现在把 `inputSchema` 照着**打算支持**的形状声明出来,有两个用处:
 *  1. `tools/list` 里能看出这块能力要什么参数(而不是一个没有入参的黑盒);
 *  2. 票 14 接上时接口已经定型,不必再改一次代理侧的调用。
 * 但也因此,这些参数**现在不产生任何行为** —— 见 `server/utils/ocr-result.ts`。
 */
export default defineMcpTool({
  name: 'get_ocr_result',
  title: '取 OCR 结果(尚未启用)',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: [
    '取某文件(或某页)的 OCR 结果 markdown(带页码)。',
    '**尚未启用**:依赖票 14 的 OCR 结果表,当前调用一律返回 501 并说明原因。',
    '在那之前:页图可用 `list_page_images` 取(票 13 已可用)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    page: z.number().int().min(1).optional().describe('页号;省略则要整份文件的 OCR 结果'),
  },
  handler: async () => {
    throw ocrNotEnabledError()
  },
})
