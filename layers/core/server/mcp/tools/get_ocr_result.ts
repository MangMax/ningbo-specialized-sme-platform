import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { fileRefShape } from '../../utils/file-agent-reference'
import { openFileStore } from '../../../../../server/utils/mcp-files'
import { getOcrResultForFile, requireOcrFileRef, ocrPageSchema } from '../../utils/ocr-page-lifecycle'

/**
 * `get_ocr_result` —— 取某文件/某页的 OCR 结果(markdown,带页码)。
 *
 * 票 18 把它留成 501 空壳,理由是「表还不存在,现造一张会把票 14 的选型提前锁死」;
 * 票 14 把 `ocr_result` 建起来之后,这里就是它的**真实现**(只读)。
 *
 * 返回两样东西,分别对应两种用法:
 *  - `markdown` —— 导出的正文(**带页标记** `<!-- page: N -->`,整份或那一页);
 *  - `results`  —— 逐页的**元数据**(页号 / 引擎 / 模型 / 通路 / 时间 / 字符数 / 页图路径)。
 *
 * 为什么两样都给:代理通常先要元数据判断「这文件识别到哪一步了」,再决定要不要正文;
 * 一次调用给全,省一轮往返。正文与元数据同源(同一次查询),不会出现两者对不上的缝隙。
 *
 * **不读图、不识别** —— 这是只读 tool。要拿图自己识别,用 `list_page_images`(票 13 的产物)。
 */
export default defineMcpTool({
  name: 'get_ocr_result',
  title: '取 OCR 结果(markdown,带页码)',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)取某文件(或某页)的 OCR 结果 markdown。',
    '返回 `markdown`(带 `<!-- page: N -->` 页标记)与 `results`(逐页元数据:page / engine / model / channel / createdAt / pageRelPath / url)。显式 includeVersion:true 才附 version,保留旧默认响应。',
    '给 `page` 只取那一页。**文件还没识别过**时返回 404 并说明可以走哪条通路。',
    'includeVersion:true 时 results[].version 是不透明页版本,可用于 save_ocr_result/delete_ocr_result 的 expectedVersion。删除后重做同页须重新读取,不能复用旧版本。',
    'includeVersion:true 时 contentIdentity 只核当前文件;results[].historicalBinding 仅报告已有采集依据,unknown 不会由当前核验升级。冲突仍保留历史文本。',
    '这是**只读** tool;写入用 `save_ocr_result`(需鉴权)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    includeVersion: z.boolean().optional().describe('显式请求现代页版本;省略保留旧 results 元数据形状'),
    page: ocrPageSchema.optional().describe('页号;省略则要整份文件的 OCR 结果'),
  },
  handler: async (input) => {
    const { db, root } = await openFileStore()
    const row = requireOcrFileRef(db, input, true)
    return getOcrResultForFile(db, row, input.page, input.includeVersion ?? false, root)
  },
})
