import { createReadStream } from 'node:fs'
import { DEFAULT_DPI, isPdfPath, normalizeDpi } from '~~/lib/pdf-page'
import { listPdfPages, pageImagePath, resolveWithinRoot } from '../utils/pdf-pages'

/**
 * PDF 页图:查现状 / 取单页像素。`GET /api/pdf-pages?file=<相对路径>[&dpi=400][&page=3]`
 *
 * - 不带 `page` → 返回 JSON:源页数、已渲染页数、是否与当前源一致、每页的尺寸与预览 URL。
 * - 带 `page` → 直接回该页的 PNG 字节。
 *
 * `file` 是**相对文件库根**的路径(与 `record_evidence.source_file` 同一口径),
 * 如 `jxj/announcement/2024/1/甬经信中小〔2024〕72号….pdf`。用查询参数而不是路径段,
 * 是因为文件名里全是中文、书名号与空格,塞进路径段要三层编码,得不偿失。
 *
 * 页图**不在 `/api/files/**` 下另开路由** —— 那里是「文件回吐」的地盘(只读给出文件库里的
 * 源文件);页图是**派生数据**,查询、按页取、触发渲染这三件事都与它无关。但页图的**字节**
 * 仍由那条回吐路由给出(见 `lib/pdf-page.ts` 里生成的 `url`),不重复造一路文件服务器。
 *
 * 本路由**只读**:渲染要写盘,走 `POST /api/pdf-pages`(单份)
 * 或 `POST /api/jobs {kind:"render-pages"}`(批量、异步)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['页图'],
    summary: '查页图现状 / 取一页 PNG',
    description: '不带 `page` 返回 JSON 现状;带 `page` 直接回该页 PNG 字节。只读,不触发渲染。',
    parameters: [
      {
        name: 'file',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: '相对文件库根的 PDF 路径(必给)。',
      },
      { name: 'dpi', in: 'query', schema: { type: 'integer', minimum: 72, maximum: 600, default: 300 } },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '给页号则回该页 PNG。' },
    ],
    responses: {
      200: {
        description: '带 `page` 时是 `image/png` 字节;不带时是现状 JSON。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                pageCount: { type: 'integer', nullable: true },
                dpi: { type: 'integer' },
                rendered: { type: 'integer' },
                upToDate: { type: 'boolean' },
                pages: { type: 'array', items: { type: 'object' } },
                defaultDpi: { type: 'integer' },
              },
            },
          },
        },
      },
      400: { description: '缺 `file` / 页号非法 / 分辨率越界。' },
      403: { description: '路径越界(必须落在文件库根内)。' },
      404: { description: '第 N 页尚未渲染。' },
      415: { description: '不是 PDF。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  const root = useRuntimeConfig().filesDir
  const q = getQuery(event)

  const file = typeof q.file === 'string' ? q.file.trim() : ''
  if (!file) {
    throw createError({ statusCode: 400, message: '缺少 file 参数(相对文件库根的 PDF 路径)' })
  }
  if (!isPdfPath(file)) {
    throw createError({ statusCode: 415, message: `不是 PDF:${file}` })
  }

  let dpi
  try {
    dpi = normalizeDpi(q.dpi)
  } catch (error) {
    throw createError({ statusCode: 400, message: (error as Error).message })
  }

  // 锁根:路径必须落在文件库内。与 `server/api/files/[...path].get.ts` 同一把关。
  try {
    resolveWithinRoot(root, file)
  } catch {
    throw createError({ statusCode: 403, message: '路径越界' })
  }

  const rawPage = typeof q.page === 'string' ? q.page : undefined
  if (rawPage === undefined) {
    return {
      ...(await listPdfPages(root, file, dpi)),
      defaultDpi: DEFAULT_DPI,
    }
  }

  const page = Number(rawPage)
  if (!Number.isInteger(page) || page < 1) {
    throw createError({ statusCode: 400, message: `页号必须是正整数:${rawPage}` })
  }

  const abs = await pageImagePath(root, file, page)
  if (!abs) {
    throw createError({
      statusCode: 404,
      message: `第 ${page} 页尚未渲染。先 POST /api/pdf-pages {"file":"${file}"} 渲染,或 GET 本路由看已渲染的页。`,
    })
  }

  setHeader(event, 'content-type', 'image/png')
  setHeader(event, 'cache-control', 'private, max-age=3600')
  setHeader(event, 'content-disposition', `inline; filename*=UTF-8''p${String(page).padStart(3, '0')}.png`)
  return sendStream(event, createReadStream(abs))
})
