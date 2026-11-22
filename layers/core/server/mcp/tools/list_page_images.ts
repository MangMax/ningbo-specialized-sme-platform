import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { DEFAULT_DPI } from '#core/lib/pdf-page'
import { fileRefShape, postgresPageImagesForAgent } from '../../utils/file-agent-reference'
import { usePostgresFileDb } from '../../utils/file-store-postgres'

/**
 * `list_page_images` —— 一份 PDF 的页图(票 18,只读;产物来自票 13)。
 *
 * 与 `GET /api/pdf-pages?file=…` **同一实现**(`listPdfPages`),
 * 连错误状态码都逐条对齐(404 文件不存在 / 415 不是 PDF / 400 分辨率 / 403 路径越界),
 * 所以同一件事从两个入口看是一致的。
 *
 * **不触发渲染。** 渲染要写盘(那是 `POST /api/pdf-pages`),而 MCP 侧的写入只碰
 * 「文件元数据 / 解析结果 / OCR 结果」—— 把 97 页 PNG 往盘上写不属于代理该顺手做的事,
 * 也就没为它开 MCP 入口。未渲染时如实返回 `rendered: 0`,由人或 `/files` 页去点渲染。
 *
 * 页图的**字节**仍由 `/api/files/**` 回吐(每页的 `url` 指过去),不另开文件服务器。
 */
export default defineMcpTool({
  name: 'list_page_images',
  title: 'PDF 页图',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: [
    '按 `fileId` 或 `relPath`(恰给其一)取一份 PDF 的页图清单。文件必须**是 PDF**(按扩展名判)。',
    '返回 `pageCount`(源页数)、`rendered`(磁盘上已有页图数)、`upToDate`(页图与当前源内容完全一致)、',
    '`pages`(每页的 `page` / `relPath` / `url` / `width` / `height` / `bytes`)、`manifest`(渲染摘要)、`defaultDpi`。',
    '`rendered: 0` 表示**还没渲染过**(不是错误)。本 tool **不会**触发渲染。',
    '`url` 可直接取该页 PNG 字节(走 `/api/files/**`)。',
  ].join('\n'),
  inputSchema: {
    ...fileRefShape,
    dpi: z
      .number()
      .int()
      .min(72)
      .max(600)
      .optional()
      .describe(`核对清单用的分辨率;默认 ${DEFAULT_DPI}(与渲染时一致才算 upToDate)`),
  },
  handler: async (input) => {
    const pg = usePostgresFileDb()
    const result = await postgresPageImagesForAgent(pg, useRuntimeConfig().filesDir, input)
    if (!result.ok) throw createError({ statusCode: result.statusCode, message: result.message })
    return { ...result.value, defaultDpi: DEFAULT_DPI }
  },
})
